// What a finished tool call means for Kaneed: a test run that passed heals it, one that failed is
// noted. Nothing else counts. `ok` is undefined when the call was denied before it ran.

export type TestEvent = 'pass' | 'fail'

// test runners across common stacks, as cc-arcade recognises them
const TEST_COMMAND =
  /\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b|\bnpx\s+(jest|vitest|mocha)\b|\b(pytest|jest|vitest|rspec|phpunit|mocha)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmake\s+test\b|\b(mvn|gradle|gradlew|sbt)\b.*\btest\b/

export function testEvent(tool: string, command: string | undefined, ok: boolean | undefined): TestEvent | undefined {
  if (ok === undefined) return undefined
  if (tool !== 'Bash' || !command) return undefined
  if (!TEST_COMMAND.test(command)) return undefined
  return ok ? 'pass' : 'fail'
}
