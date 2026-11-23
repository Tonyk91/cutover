/** Fail at cold start, not on the first message, if the deploy forgot a variable. */
export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}
