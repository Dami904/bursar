import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "contracts/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // Money is integer micro-USDC (bigint) everywhere. Parsing money as a float is a bug.
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Use @bursar/money to parse amounts, never floats." },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Number",
          property: "parseFloat",
          message: "Use @bursar/money to parse amounts, never floats.",
        },
      ],
    },
  },
  {
    // Tests assert on rows they just created; `!` there documents the expectation.
    files: ["**/test/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
