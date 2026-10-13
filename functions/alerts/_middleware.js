// The alert feed is read only by functions/api/push-run.js (through env.ASSETS), never served:
// it carries this week's calls even when the paywall is on.
export const onRequest = () => new Response('Not found', { status: 404 });
