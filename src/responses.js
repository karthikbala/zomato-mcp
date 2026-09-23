import { ServiceError } from './security.js';

export function toolResult(value, identity) {
  const structuredContent = { ...value, identity };
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  };
}
export function toolError(error, identity, loginUrl) {
  return {
    ...toolResult(
      {
        code: error.code || 'SITE_UNAVAILABLE',
        message:
          error instanceof ServiceError ? error.message : 'Read failed; check session status.',
        loginUrl,
      },
      identity,
    ),
    isError: true,
  };
}
export function decorateToolMessage(message, identity) {
  if (message.error)
    return { ...message, error: { ...message.error, data: { ...message.error.data, identity } } };
  if (!message.result || message.result.structuredContent?.identity) return message;
  const structuredContent = { ...message.result.structuredContent, identity };
  return {
    ...message,
    result: {
      ...message.result,
      structuredContent,
      content: [
        ...(message.result.content || []),
        { type: 'text', text: JSON.stringify(structuredContent) },
      ],
    },
  };
}
export function toolMessageDecorator(body, getIdentity) {
  const requests = Array.isArray(body) ? body : [body];
  const ids = new Set(
    requests.filter((x) => x?.method === 'tools/call' && Object.hasOwn(x, 'id')).map((x) => x.id),
  );
  return (message) =>
    Object.hasOwn(message, 'id') && ids.has(message.id)
      ? decorateToolMessage(message, getIdentity())
      : message;
}
