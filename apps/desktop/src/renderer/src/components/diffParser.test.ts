import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diffParser.js";

const SAMPLE = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 ctx line
-old line
+new line one
+new line two
 more ctx
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/asset.png b/asset.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/asset.png differ
`;

describe("parseUnifiedDiff", () => {
  it("groups hunks per file with added/removed counts", () => {
    const files = parseUnifiedDiff(SAMPLE);
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "src/new.ts", "src/gone.ts", "asset.png"]);

    const [modified, added, deleted, binary] = files;
    expect(modified.status).toBe("modified");
    expect(modified.added).toBe(2);
    expect(modified.removed).toBe(1);
    expect(modified.lines.map((l) => l.type)).toEqual(["hunk", "ctx", "del", "add", "add", "ctx"]);

    expect(added.status).toBe("added");
    expect(added.added).toBe(2);

    expect(deleted.status).toBe("deleted");
    expect(deleted.removed).toBe(1);

    expect(binary.binary).toBe(true);
  });
});
