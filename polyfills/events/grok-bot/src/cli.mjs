if (process.argv.includes('--arm-once')) {
    await import('./watch.ts');
} else {
    const { runCli } = await import('./bridge.mjs');
    try {
        await runCli(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
