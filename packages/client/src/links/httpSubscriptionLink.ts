import { observable } from '@trpc/server/observable';
import type {
  AnyClientTypes,
  inferClientTypes,
  InferrableClientTypes,
} from '@trpc/server/unstable-core-do-not-import';
import {
  run,
  sseStreamConsumer,
} from '@trpc/server/unstable-core-do-not-import';
import { TRPCClientError } from '../TRPCClientError';
import { getTransformer, type TransformerOptions } from '../unstable-internals';
import { getUrl } from './internals/httpUtils';
import {
  resultOf,
  type UrlOptionsWithConnectionParams,
} from './internals/urlWithConnectionParams';
import type { TRPCLink } from './types';

async function urlWithConnectionParams(
  opts: UrlOptionsWithConnectionParams,
): Promise<string> {
  let url = await resultOf(opts.url);
  if (opts.connectionParams) {
    const params = await resultOf(opts.connectionParams);

    const prefix = url.includes('?') ? '&' : '?';
    url +=
      prefix + 'connectionParams=' + encodeURIComponent(JSON.stringify(params));
  }

  return url;
}

type HTTPSubscriptionLinkOptions<TRoot extends AnyClientTypes> = {
  /**
   * EventSource options or a callback that returns them
   */
  eventSourceOptions?: () => EventSourceInit | Promise<EventSourceInit>;
} & TransformerOptions<TRoot> &
  UrlOptionsWithConnectionParams;

/**
 * @see https://trpc.io/docs/client/links/httpSubscriptionLink
 */
export function unstable_httpSubscriptionLink<
  TInferrable extends InferrableClientTypes,
>(
  opts: HTTPSubscriptionLinkOptions<inferClientTypes<TInferrable>>,
): TRPCLink<TInferrable> {
  const transformer = getTransformer(opts.transformer);

  return () => {
    return ({ op }) => {
      return observable((observer) => {
        const { type, path, input } = op;
        /* istanbul ignore if -- @preserve */
        if (type !== 'subscription') {
          throw new Error('httpSubscriptionLink only supports subscriptions');
        }

        let eventSource: EventSource | null = null;
        let unsubscribed = false;

        function startSubscription() {
          run(async () => {
            const url = getUrl({
              transformer,
              url: await urlWithConnectionParams(opts),
              input,
              path,
              type,
              signal: null,
            });

            const eventSourceOptions = await resultOf(opts.eventSourceOptions);
            /* istanbul ignore if -- @preserve */
            if (unsubscribed) {
              // already unsubscribed - rare race condition
              return;
            }

            eventSource = new EventSource(url, eventSourceOptions);

            const onStarted = () => {
              observer.next({
                result: {
                  type: 'started',
                },
                context: {
                  eventSource,
                },
              });

              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              eventSource!.removeEventListener('open', onStarted);
            };
            // console.log('starting', new Date());
            eventSource.addEventListener('open', onStarted);

            eventSource.addEventListener('error', (ev) => {
              if (
                'status' in ev &&
                typeof ev.status === 'number' &&
                [401, 403].includes(ev.status)
              ) {
                console.log('Restarted EventSource due to 401/403 error');

                const oldEventSource = eventSource;
                oldEventSource?.close();

                startSubscription();
              }
            });

            const iterable = sseStreamConsumer<
              Partial<{
                id?: string;
                data: unknown;
              }>
            >({
              from: eventSource,
              deserialize: transformer.output.deserialize,
            });

            for await (const chunk of iterable) {
              if (!chunk.ok) {
                // TODO: handle in https://github.com/trpc/trpc/issues/5871
                continue;
              }
              const chunkData = chunk.data;

              // if the `tracked()`-helper is used, we always have an `id` field
              const data = 'id' in chunkData ? chunkData : chunkData.data;
              observer.next({
                result: {
                  data,
                },
              });
            }

            observer.next({
              result: {
                type: 'stopped',
              },
            });
            observer.complete();
          }).catch((error) => {
            observer.error(TRPCClientError.from(error));
          });
        }

        startSubscription();

        return () => {
          observer.complete();
          eventSource?.close();
          unsubscribed = true;
        };
      });
    };
  };
}
