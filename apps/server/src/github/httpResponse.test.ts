import { describe, expect, it } from "bun:test";
import { parseGhIncludeOutput } from "./httpResponse.js";

describe("parseGhIncludeOutput", () => {
  it("parses a 200 response with a JSON body", () => {
    const out = ['HTTP/2.0 200 OK', 'Content-Type: application/json; charset=utf-8', 'Etag: W/"abc"', "", '{"id":1,"name":"x"}'].join("\n");
    const parsed = parseGhIncludeOutput(out);
    expect(parsed?.status).toBe(200);
    expect(parsed?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(parsed?.headers["etag"]).toBe('W/"abc"');
    expect(JSON.parse(parsed?.body ?? "")).toEqual({ id: 1, name: "x" });
  });

  it("parses a 304 with no body", () => {
    const out = ["HTTP/2.0 304 Not Modified", "Access-Control-Allow-Origin: *", "X-Poll-Interval: 60", ""].join("\n");
    expect(parseGhIncludeOutput(out)).toEqual({
      status: 304,
      headers: { "access-control-allow-origin": "*", "x-poll-interval": "60" },
      body: ""
    });
  });

  it("handles CRLF line endings", () => {
    const out = "HTTP/2.0 304 Not Modified\r\nEtag: \"e1\"\r\nX-Poll-Interval: 60\r\n\r\n";
    expect(parseGhIncludeOutput(out)).toEqual({ status: 304, headers: { etag: '"e1"', "x-poll-interval": "60" }, body: "" });
    const withBody = parseGhIncludeOutput("HTTP/2.0 200 OK\r\nEtag: \"e2\"\r\n\r\n[1,2]");
    expect(withBody?.status).toBe(200);
    expect(withBody?.body).toBe("[1,2]");
  });

  it("keeps the last value of headers that differ only by case", () => {
    const out = ["HTTP/2.0 200 OK", "X-Thing: first", "x-thing: second", "X-THING: third", "", "{}"].join("\n");
    expect(parseGhIncludeOutput(out)?.headers["x-thing"]).toBe("third");
  });

  it("returns null for output that is not an HTTP response", () => {
    expect(parseGhIncludeOutput("")).toBeNull();
    expect(parseGhIncludeOutput("gh: Not Found (HTTP 404)")).toBeNull();
    expect(parseGhIncludeOutput('{"message":"Bad credentials"}')).toBeNull();
  });
});
