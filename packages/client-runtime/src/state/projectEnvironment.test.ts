import { describe, expect, it } from "vite-plus/test";

import { diffEnvrc } from "./projectEnvironment.ts";

describe("diffEnvrc", () => {
  it("marks removed and added lines around the unchanged ones", () => {
    expect(
      diffEnvrc(
        "use flake\ndotenv\nwatch_file flake.lock",
        "use flake\nexport A=1\nwatch_file flake.lock",
      ),
    ).toEqual([
      { kind: "same", text: "use flake" },
      { kind: "removed", text: "dotenv" },
      { kind: "added", text: "export A=1" },
      { kind: "same", text: "watch_file flake.lock" },
    ]);
  });
});
