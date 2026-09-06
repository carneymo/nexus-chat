// Vinext beta exits immediately after native Rolldown worker cleanup. On Windows,
// Node 24 can abort while those async handles are still closing. Give successful
// builds one event-loop grace period; failures preserve their original exit code.
if (process.platform === 'win32') {
  const exit = process.exit.bind(process);
  let scheduled = false;
  process.exit = (code) => {
    if (code === 0) {
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => exit(0), 1000);
      }
    } else exit(code);
  };
}
process.argv = [process.argv[0], 'vinext', 'build', ...process.argv.slice(2)];
await import('../node_modules/vinext/dist/cli.js');
