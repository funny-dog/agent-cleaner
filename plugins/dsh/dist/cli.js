#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { ensureBinaryPath, findExistingBinaryPath } from './index.js';
import { runSetupCli } from './setup.js';
async function main() {
    const subcommand = process.argv[2];
    if (subcommand === 'setup' || subcommand === 'plugin' || subcommand === 'install-plugin') {
        await runSetupCli(process.argv.slice(3));
        return;
    }
    let binaryPath = findExistingBinaryPath();
    if (!binaryPath) {
        process.stderr.write('Downloading prebuilt agent-cleaner binary...\n');
        binaryPath = await ensureBinaryPath();
    }
    const child = spawn(binaryPath, process.argv.slice(2), {
        stdio: 'inherit',
    });
    const forwardSignal = (signal) => {
        if (!child.killed) {
            child.kill(signal);
        }
    };
    const onSigInt = () => forwardSignal('SIGINT');
    const onSigTerm = () => forwardSignal('SIGTERM');
    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    child.on('error', (err) => {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
        process.stderr.write(`Failed to start agent-cleaner: ${err.message}\n`);
        process.exit(1);
    });
    child.on('exit', (code, signal) => {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
        if (signal) {
            if (process.platform === 'win32') {
                process.exit(1);
            }
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 0);
    });
}
main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-cleaner error: ${message}\n`);
    process.exit(1);
});
