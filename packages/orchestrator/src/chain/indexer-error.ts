/** The indexer answered a request with an error status; 4xx answers are final (bad body, auth, conflict). */
export class IndexerRefused extends Error {
  constructor(
    readonly status: number,
    what: string,
    body: string,
  ) {
    super(`indexer refused the ${what}: HTTP ${status} ${body.slice(0, 200)}`);
    this.name = "IndexerRefused";
  }
}
