import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "modules/*/dist", "src-tauri", "release", "docs"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // unused locals are already a tsc error (noUnusedLocals)
      "@typescript-eslint/no-unused-vars": "off",
      // `a || b()` and `(x = 1), (y = 2)` one-liners are used on purpose
      "@typescript-eslint/no-unused-expressions": "off",
      // the few `any`s are at IPC/plugin boundaries; keep them visible without failing CI
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
