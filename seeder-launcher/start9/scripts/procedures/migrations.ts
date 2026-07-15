import { compat, types as T } from "../deps.ts";

// No cross-version data migrations yet; declare the current version so StartOS
// treats fresh installs and same-version reinstalls as up to date.
export const migration: T.ExpectedExports.migration = compat.migrations
  .fromMapping({}, "1.0.20");
