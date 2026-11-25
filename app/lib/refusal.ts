/**
 * What the editor, the API and the MCP server refuse, in one shape: an HTTP
 * status, a stable code for programs, and a sentence for people.
 */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
