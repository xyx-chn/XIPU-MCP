export function parseDeadlineLink(raw: string, knownId: (id: string) => boolean): {deadlineId?: string} | null {
  if (raw.length > 2048) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'xipu-mcp:' || url.hostname !== 'deadlines' || url.username || url.password || url.port || url.hash || !['','/'].includes(url.pathname)) return null;
  const entries = [...url.searchParams.entries()];
  if (!entries.length) return {};
  if (entries.length !== 1 || entries[0][0] !== 'id' || !knownId(entries[0][1])) return null;
  return {deadlineId: entries[0][1]};
}

export function isDefaultDeadlineQuery(args: {courseIds?: string[]; from?: string; to?: string}) {
  return args.courseIds === undefined && args.from === undefined && args.to === undefined;
}
