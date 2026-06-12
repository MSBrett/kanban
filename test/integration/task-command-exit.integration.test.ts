import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

async function waitForServerStart(process: ChildProcess, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolveStart, rejectStart) => {
		if (!process.stdout || !process.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (!stdout.includes("Cline Kanban running at ") || settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
		};
		process.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		process.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		process.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

function installBrowserOpenStub(binDir: string, logPath: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = `#!/usr/bin/env sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`;
	const commandNames = process.platform === "darwin" ? ["open"] : ["xdg-open"];
	for (const commandName of commandNames) {
		const scriptPath = join(binDir, commandName);
		writeFileSync(scriptPath, script, "utf8");
		chmodSync(scriptPath, 0o755);
	}
}

function readBrowserOpenLog(logPath: string): string[] {
	if (!existsSync(logPath)) {
		return [];
	}
	return readFileSync(logPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function waitForBrowserOpenCount(logPath: string, expectedCount: number, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (readBrowserOpenLog(logPath).length >= expectedCount) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	throw new Error(
		`Timed out waiting for browser open count ${expectedCount}. Current log: ${readBrowserOpenLog(logPath).join(", ")}`,
	);
}

async function waitForExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (process.exitCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			process.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		process.once("exit", handleExit);
	});
}

async function requestGracefulShutdown(process: ChildProcess): Promise<void> {
	if (typeof process.send !== "function" || !process.connected) {
		process.kill("SIGINT");
		return;
	}

	await new Promise<void>((resolveSend) => {
		process.send?.({ type: "kanban.shutdown" }, () => {
			resolveSend();
		});
	});
}

function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(process, options.timeoutMs ?? 8_000);
	if (!didExit) {
		process.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		didExit,
	};
}

describe("source task commands", () => {
	it("exits after creating a task when the runtime server is already running", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-exit-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-exit-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Exit Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const commandProcess = spawnSourceCli(
					[
						"task",
						"create",
						"--prompt",
						"Add a demo banner component to the homepage that displays a welcome message and current weather summary",
						"--project-path",
						projectPath,
					],
					{
						cwd: projectPath,
						env,
					},
				);

				let stdout = "";
				let stderr = "";
				commandProcess.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				commandProcess.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				const didExit = await waitForExit(commandProcess, 8_000);
				if (!didExit) {
					commandProcess.kill("SIGKILL");
				}

				expect(didExit, `task create did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);
				expect(commandProcess.exitCode).toBe(0);
				expect(stdout).toContain('"ok": true');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("opens only for launch invocations", { timeout: 60_000 }, async () => {
		if (process.platform === "win32") {
			return;
		}

		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-root-launch-open-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-root-launch-open-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Root Launch Browser Open Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const browserStubBinDir = join(homeDir, "browser-bin");
			const browserOpenLogPath = join(homeDir, "browser-open.log");
			installBrowserOpenStub(browserStubBinDir, browserOpenLogPath);
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: `${browserStubBinDir}:${process.env.PATH ?? ""}`,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				for (const [args, expectedOpenCount] of [
					[[], 1],
					[["task", "list", "--project-path", projectPath], 1],
					[["--host", "127.0.0.1"], 2],
					[["--port", port], 3],
				] as const) {
					const result = await runCliCommandAndCollectOutput({
						args: [...args],
						cwd: projectPath,
						env,
					});
					expect(result.didExit).toBe(true);
					expect(result.exitCode).toBe(0);
					await waitForBrowserOpenCount(browserOpenLogPath, expectedOpenCount);
					expect(readBrowserOpenLog(browserOpenLogPath)).toHaveLength(expectedOpenCount);
				}
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("supports process assignment and pass/fail CLI transitions", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-process-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-process-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Process Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const processJsonPath = join(projectPath, "cli-process.json");
				const cliProcessDefinition = {
					schemaVersion: 1,
					id: "cli-process",
					name: "CLI Process",
					initial: "pending",
					states: {
						pending: { label: "Pending", on: { pass: "swe" } },
						swe: {
							label: "SWE",
							role: "swe",
							agentId: "codex",
							prompt: "Implement the item, record evidence, then pass or fail.",
							on: { fail: "pending", pass: "done" },
							conditions: [
								{
									verdict: "fail",
									path: "agent",
									equals: "user",
									target: "research",
									label: "User rejection restarts research.",
								},
							],
						},
						research: {
							label: "Research",
							role: "research",
							agentId: "codex",
							prompt: "Research the rejected direction.",
							on: { pass: "swe" },
						},
						done: { label: "Done", terminal: true, on: {} },
					},
				};
				const removableProcessDefinition = {
					schemaVersion: 1,
					id: "removable-process",
					name: "Removable Process",
					initial: "pending",
					states: {
						pending: { label: "Pending", on: { pass: "done" } },
						done: { label: "Done", terminal: true, on: {} },
					},
				};
				writeFileSync(
					processJsonPath,
					`${JSON.stringify([cliProcessDefinition, removableProcessDefinition], null, 2)}\n`,
					"utf8",
				);

				const importedProcess = await runCliCommandAndCollectOutput({
					args: ["task", "process", "import", "--file", processJsonPath, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					importedProcess.didExit,
					`task process import did not exit.\nstdout:\n${importedProcess.stdout}\nstderr:\n${importedProcess.stderr}`,
				).toBe(true);
				expect(importedProcess.exitCode).toBe(0);
				const importedProcessPayload = JSON.parse(importedProcess.stdout) as {
					ok?: boolean;
					importedProcessIds?: string[];
					customProcesses?: Array<{ id?: string; source?: string }>;
				};
				expect(importedProcessPayload.ok).toBe(true);
				expect(importedProcessPayload.importedProcessIds).toEqual(["cli-process", "removable-process"]);
				expect(importedProcessPayload.customProcesses).toEqual(
					expect.arrayContaining([expect.objectContaining({ id: "cli-process", source: "custom" })]),
				);

				const promptlessProcessJsonPath = join(projectPath, "promptless-process.json");
				writeFileSync(
					promptlessProcessJsonPath,
					`${JSON.stringify(
						{
							schemaVersion: 1,
							id: "promptless-process",
							name: "Promptless Process",
							initial: "pending",
							states: {
								pending: { label: "Pending", on: { pass: "swe" } },
								swe: {
									label: "SWE",
									role: "swe",
									agentId: "codex",
									on: { fail: "pending", pass: "done" },
								},
								done: { label: "Done", terminal: true, on: {} },
							},
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const promptlessImport = await runCliCommandAndCollectOutput({
					args: ["task", "process", "import", "--file", promptlessProcessJsonPath, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					promptlessImport.didExit,
					`promptless task process import did not exit.\nstdout:\n${promptlessImport.stdout}\nstderr:\n${promptlessImport.stderr}`,
				).toBe(true);
				expect(promptlessImport.exitCode).not.toBe(0);
				const promptlessImportPayload = JSON.parse(promptlessImport.stdout) as { ok?: boolean; error?: string };
				expect(promptlessImportPayload.ok).toBe(false);
				expect(promptlessImportPayload.error).toContain(
					'Process "promptless-process" must define prompt(s) for runnable stage(s): swe.',
				);

				const listedProcesses = await runCliCommandAndCollectOutput({
					args: ["task", "process", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedProcesses.didExit,
					`task process list did not exit.\nstdout:\n${listedProcesses.stdout}\nstderr:\n${listedProcesses.stderr}`,
				).toBe(true);
				expect(listedProcesses.exitCode).toBe(0);
				const listedProcessesPayload = JSON.parse(listedProcesses.stdout) as {
					ok?: boolean;
					processes?: Array<{ id?: string; source?: string }>;
				};
				expect(listedProcessesPayload.ok).toBe(true);
				expect(listedProcessesPayload.processes).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ id: "lightweight", source: "built-in" }),
						expect.objectContaining({ id: "cli-process", source: "custom" }),
					]),
				);

				const exportedProcess = await runCliCommandAndCollectOutput({
					args: ["task", "process", "export", "--process", "cli-process", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					exportedProcess.didExit,
					`task process export did not exit.\nstdout:\n${exportedProcess.stdout}\nstderr:\n${exportedProcess.stderr}`,
				).toBe(true);
				expect(exportedProcess.exitCode).toBe(0);
				const exportedProcessPayload = JSON.parse(exportedProcess.stdout) as {
					ok?: boolean;
					process?: { id?: string; source?: string; states?: { swe?: { prompt?: string } } };
					definition?: typeof cliProcessDefinition;
				};
				expect(exportedProcessPayload.ok).toBe(true);
				expect(exportedProcessPayload.process).toMatchObject({
					id: "cli-process",
					source: "custom",
					states: { swe: { prompt: "Implement the item, record evidence, then pass or fail." } },
				});
				expect(exportedProcessPayload.definition).toMatchObject(cliProcessDefinition);
				expect(exportedProcessPayload.definition).not.toHaveProperty("source");

				const created = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--task-id",
						"T-1.1",
						"--prompt",
						"Create a process-backed task for CLI transition testing",
						"--process",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					created.didExit,
					`task create --process did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
				).toBe(true);
				expect(created.exitCode).toBe(0);
				const createdPayload = JSON.parse(created.stdout) as {
					ok?: boolean;
					task?: { id?: string; process?: { id?: string; stageId?: string; status?: string } | null };
				};
				expect(createdPayload.ok).toBe(true);
				expect(createdPayload.task?.id).toBe("T-1.1");
				expect(createdPayload.task?.process).toMatchObject({
					id: "cli-process",
					stageId: "pending",
					status: "ready",
				});
				const taskId = createdPayload.task?.id;
				expect(typeof taskId).toBe("string");

				const duplicateCreated = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--task-id",
						"T-1.1",
						"--prompt",
						"Duplicate explicit task id should fail",
						"--process",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					duplicateCreated.didExit,
					`duplicate task create did not exit.\nstdout:\n${duplicateCreated.stdout}\nstderr:\n${duplicateCreated.stderr}`,
				).toBe(true);
				expect(duplicateCreated.exitCode).not.toBe(0);
				const duplicateCreatedPayload = JSON.parse(duplicateCreated.stdout) as { ok?: boolean; error?: string };
				expect(duplicateCreatedPayload.ok).toBe(false);
				expect(duplicateCreatedPayload.error).toContain('Task "T-1.1" already exists.');

				const prematureDone = await runCliCommandAndCollectOutput({
					args: ["task", "done", "--task-id", taskId ?? "", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					prematureDone.didExit,
					`premature task done did not exit.\nstdout:\n${prematureDone.stdout}\nstderr:\n${prematureDone.stderr}`,
				).toBe(true);
				expect(prematureDone.exitCode).not.toBe(0);
				const prematureDonePayload = JSON.parse(prematureDone.stdout) as { ok?: boolean; error?: string };
				expect(prematureDonePayload.ok).toBe(false);
				expect(prematureDonePayload.error).toContain(
					`Task "${taskId}" has an incomplete process at stage "pending".`,
				);

				const passed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						taskId ?? "",
						"--notes",
						"pending passed by CLI",
						"--agent",
						"cli-test",
						"--expected-stage",
						"pending",
						"--pipeline",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					passed.didExit,
					`task process pass did not exit.\nstdout:\n${passed.stdout}\nstderr:\n${passed.stderr}`,
				).toBe(true);
				expect(passed.exitCode).toBe(0);
				const passedPayload = JSON.parse(passed.stdout) as {
					ok?: boolean;
					process?: {
						stageId?: string;
						history?: Array<{ recordKind?: string; stageId?: string; verdict?: string; notes?: string }>;
					};
				};
				expect(passedPayload.ok).toBe(true);
				expect(passedPayload.process?.stageId).toBe("swe");
				expect(passedPayload.process?.history).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							recordKind: "dispatch",
							stageId: "pending",
							verdict: "pass",
							notes: "pending passed by CLI",
						}),
					]),
				);

				const unguardedFailed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"fail",
						"--task-id",
						taskId ?? "",
						"--notes",
						"unguarded swe fail should be rejected",
						"--agent",
						"cli-test",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					unguardedFailed.didExit,
					`unguarded task process fail did not exit.\nstdout:\n${unguardedFailed.stdout}\nstderr:\n${unguardedFailed.stderr}`,
				).toBe(true);
				expect(unguardedFailed.exitCode).not.toBe(0);
				const unguardedFailedPayload = JSON.parse(unguardedFailed.stdout) as {
					ok?: boolean;
					error?: string;
				};
				expect(unguardedFailedPayload.ok).toBe(false);
				expect(unguardedFailedPayload.error).toContain(
					`Task "${taskId}" is at process stage "swe". Provide --expected-stage swe before running task process fail.`,
				);

				const failed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"fail",
						"--task-id",
						taskId ?? "",
						"--notes",
						"swe failed by CLI",
						"--agent",
						"cli-test",
						"--expected-stage",
						"swe",
						"--pipeline",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					failed.didExit,
					`task process fail did not exit.\nstdout:\n${failed.stdout}\nstderr:\n${failed.stderr}`,
				).toBe(true);
				expect(failed.exitCode).toBe(0);
				const failedPayload = JSON.parse(failed.stdout) as {
					ok?: boolean;
					process?: {
						stageId?: string;
						history?: Array<{ recordKind?: string; stageId?: string; verdict?: string; notes?: string }>;
					};
				};
				expect(failedPayload.ok).toBe(true);
				expect(failedPayload.process?.stageId).toBe("pending");
				expect(failedPayload.process?.history).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							recordKind: "dispatch",
							stageId: "swe",
							notes: "Accepted guarded CLI verdict for swe.",
						}),
						expect.objectContaining({
							recordKind: "outcome",
							stageId: "swe",
							verdict: "fail",
							notes: "swe failed by CLI",
						}),
					]),
				);

				const processStatus = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"status",
						"--process",
						"cli-process",
						"--ready-stage",
						"swe",
						"--ready",
						"true",
						"--summary",
						"true",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					processStatus.didExit,
					`task process status did not exit.\nstdout:\n${processStatus.stdout}\nstderr:\n${processStatus.stderr}`,
				).toBe(true);
				expect(processStatus.exitCode).toBe(0);
				const processStatusPayload = JSON.parse(processStatus.stdout) as {
					ok?: boolean;
					tasks?: Array<{
						id?: string;
						ready?: boolean;
						blocked?: boolean;
						process?: { id?: string; stageId?: string; readyStageId?: string };
					}>;
					summary?: {
						ready?: number;
						blocked?: number;
						byProcess?: Record<string, number>;
						byStage?: Record<string, number>;
					};
				};
				expect(processStatusPayload.ok).toBe(true);
				expect(processStatusPayload.tasks).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: taskId,
							ready: true,
							blocked: false,
							process: expect.objectContaining({
								id: "cli-process",
								stageId: "pending",
								readyStageId: "swe",
							}),
						}),
					]),
				);
				expect(processStatusPayload.summary?.ready).toBeGreaterThanOrEqual(1);
				expect(processStatusPayload.summary?.byProcess?.["cli-process"]).toBeGreaterThanOrEqual(1);
				expect(processStatusPayload.summary?.byStage?.pending).toBeGreaterThanOrEqual(1);

				const currentStageStatus = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"status",
						"--process",
						"cli-process",
						"--stage",
						"pending",
						"--ready",
						"true",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					currentStageStatus.didExit,
					`task process status --stage pending did not exit.\nstdout:\n${currentStageStatus.stdout}\nstderr:\n${currentStageStatus.stderr}`,
				).toBe(true);
				expect(currentStageStatus.exitCode).toBe(0);
				const currentStageStatusPayload = JSON.parse(currentStageStatus.stdout) as {
					ok?: boolean;
					tasks?: Array<{
						id?: string;
						ready?: boolean;
						process?: { id?: string; stageId?: string; readyStageId?: string };
					}>;
				};
				expect(currentStageStatusPayload.ok).toBe(true);
				expect(currentStageStatusPayload.tasks).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: taskId,
							ready: true,
							process: expect.objectContaining({
								id: "cli-process",
								stageId: "pending",
								readyStageId: "swe",
							}),
						}),
					]),
				);

				const unguardedAppend = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"append",
						"--task-id",
						taskId ?? "",
						"--notes",
						"unguarded append should be rejected",
						"--agent",
						"cli-test",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					unguardedAppend.didExit,
					`unguarded task process append did not exit.\nstdout:\n${unguardedAppend.stdout}\nstderr:\n${unguardedAppend.stderr}`,
				).toBe(true);
				expect(unguardedAppend.exitCode).not.toBe(0);
				const unguardedAppendPayload = JSON.parse(unguardedAppend.stdout) as { ok?: boolean; error?: string };
				expect(unguardedAppendPayload.ok).toBe(false);
				expect(unguardedAppendPayload.error).toContain(
					`Task "${taskId}" process append requires --expected-stage pending.`,
				);

				const guardedAppend = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"append",
						"--task-id",
						taskId ?? "",
						"--notes",
						"guarded append evidence",
						"--agent",
						"cli-test",
						"--expected-stage",
						"pending",
						"--pipeline",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					guardedAppend.didExit,
					`guarded task process append did not exit.\nstdout:\n${guardedAppend.stdout}\nstderr:\n${guardedAppend.stderr}`,
				).toBe(true);
				expect(guardedAppend.exitCode).toBe(0);
				const guardedAppendPayload = JSON.parse(guardedAppend.stdout) as {
					ok?: boolean;
					process?: { history?: Array<{ recordKind?: string; stageId?: string; notes?: string }> };
				};
				expect(guardedAppendPayload.ok).toBe(true);
				expect(guardedAppendPayload.process?.history).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							recordKind: "append",
							stageId: "pending",
							notes: "guarded append evidence",
						}),
					]),
				);

				const processHistory = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"history",
						"--task-id",
						taskId ?? "",
						"--pipeline",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					processHistory.didExit,
					`task process history did not exit.\nstdout:\n${processHistory.stdout}\nstderr:\n${processHistory.stderr}`,
				).toBe(true);
				expect(processHistory.exitCode).toBe(0);
				const processHistoryPayload = JSON.parse(processHistory.stdout) as {
					ok?: boolean;
					count?: number;
					history?: Array<{ recordKind?: string; stageId?: string; targetStageId?: string; verdict?: string }>;
				};
				expect(processHistoryPayload.ok).toBe(true);
				expect(processHistoryPayload.count).toBe(4);
				expect(processHistoryPayload.history).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							recordKind: "dispatch",
							stageId: "pending",
							targetStageId: "swe",
							verdict: "pass",
						}),
						expect.objectContaining({ recordKind: "dispatch", stageId: "swe" }),
						expect.objectContaining({
							recordKind: "outcome",
							stageId: "swe",
							targetStageId: "pending",
							verdict: "fail",
						}),
						expect.objectContaining({
							recordKind: "append",
							stageId: "pending",
						}),
					]),
				);

				const processBody = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"body",
						"--task-id",
						taskId ?? "",
						"--pipeline",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					processBody.didExit,
					`task process body did not exit.\nstdout:\n${processBody.stdout}\nstderr:\n${processBody.stderr}`,
				).toBe(true);
				expect(processBody.exitCode).toBe(0);
				const processBodyPayload = JSON.parse(processBody.stdout) as {
					ok?: boolean;
					body?: string;
				};
				expect(processBodyPayload.ok).toBe(true);
				expect(processBodyPayload.body).toBe("Create a process-backed task for CLI transition testing");

				const wrongPipelineHistory = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"history",
						"--task-id",
						taskId ?? "",
						"--pipeline",
						"wrong-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					wrongPipelineHistory.didExit,
					`wrong-pipeline task process history did not exit.\nstdout:\n${wrongPipelineHistory.stdout}\nstderr:\n${wrongPipelineHistory.stderr}`,
				).toBe(true);
				expect(wrongPipelineHistory.exitCode).not.toBe(0);
				const wrongPipelineHistoryPayload = JSON.parse(wrongPipelineHistory.stdout) as {
					ok?: boolean;
					error?: string;
				};
				expect(wrongPipelineHistoryPayload.ok).toBe(false);
				expect(wrongPipelineHistoryPayload.error).toContain(
					`Task "${taskId}" is assigned to process "cli-process", expected "wrong-process".`,
				);

				const conditionalPendingPassed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						taskId ?? "",
						"--notes",
						"pending passed before conditional fail",
						"--agent",
						"cli-test",
						"--expected-stage",
						"pending",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					conditionalPendingPassed.didExit,
					`task process pass before conditional fail did not exit.\nstdout:\n${conditionalPendingPassed.stdout}\nstderr:\n${conditionalPendingPassed.stderr}`,
				).toBe(true);
				expect(conditionalPendingPassed.exitCode).toBe(0);

				const conditionalFailed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"fail",
						"--task-id",
						taskId ?? "",
						"--notes",
						"user rejected the direction",
						"--agent",
						"user",
						"--expected-stage",
						"swe",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					conditionalFailed.didExit,
					`task process conditional fail did not exit.\nstdout:\n${conditionalFailed.stdout}\nstderr:\n${conditionalFailed.stderr}`,
				).toBe(true);
				expect(conditionalFailed.exitCode).toBe(0);
				const conditionalFailedPayload = JSON.parse(conditionalFailed.stdout) as {
					ok?: boolean;
					process?: {
						stageId?: string;
						history?: Array<{ stageId?: string; targetStageId?: string; agent?: string }>;
					};
				};
				expect(conditionalFailedPayload.ok).toBe(true);
				expect(conditionalFailedPayload.process?.stageId).toBe("research");
				expect(conditionalFailedPayload.process?.history?.at(-1)).toMatchObject({
					stageId: "swe",
					targetStageId: "research",
					agent: "user",
				});

				const reopenCreated = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a completed process task for CLI reopen testing",
						"--process",
						"cli-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					reopenCreated.didExit,
					`task create reopen fixture did not exit.\nstdout:\n${reopenCreated.stdout}\nstderr:\n${reopenCreated.stderr}`,
				).toBe(true);
				expect(reopenCreated.exitCode).toBe(0);
				const reopenCreatedPayload = JSON.parse(reopenCreated.stdout) as { task?: { id?: string } };
				const reopenTaskId = reopenCreatedPayload.task?.id;
				expect(typeof reopenTaskId).toBe("string");

				const reopenPendingPassed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						reopenTaskId ?? "",
						"--notes",
						"pending passed before reopen",
						"--agent",
						"cli-test",
						"--expected-stage",
						"pending",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					reopenPendingPassed.didExit,
					`task process pass reopen pending did not exit.\nstdout:\n${reopenPendingPassed.stdout}\nstderr:\n${reopenPendingPassed.stderr}`,
				).toBe(true);
				expect(reopenPendingPassed.exitCode).toBe(0);

				const reopenSwePassed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						reopenTaskId ?? "",
						"--notes",
						"swe passed before reopen",
						"--agent",
						"cli-test",
						"--expected-stage",
						"swe",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					reopenSwePassed.didExit,
					`task process pass reopen swe did not exit.\nstdout:\n${reopenSwePassed.stdout}\nstderr:\n${reopenSwePassed.stderr}`,
				).toBe(true);
				expect(reopenSwePassed.exitCode).toBe(0);
				const reopenSwePassedPayload = JSON.parse(reopenSwePassed.stdout) as {
					ok?: boolean;
					completed?: boolean;
					movedToDone?: boolean;
				};
				expect(reopenSwePassedPayload).toMatchObject({
					ok: true,
					completed: true,
					movedToDone: true,
				});

				const reopened = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"reopen",
						"--task-id",
						reopenTaskId ?? "",
						"--notes",
						"reopen completed process",
						"--agent",
						"pm",
						"--expected-stage",
						"done",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					reopened.didExit,
					`task process reopen did not exit.\nstdout:\n${reopened.stdout}\nstderr:\n${reopened.stderr}`,
				).toBe(true);
				expect(
					reopened.exitCode,
					`task process reopen failed.\nstdout:\n${reopened.stdout}\nstderr:\n${reopened.stderr}`,
				).toBe(0);
				const reopenedPayload = JSON.parse(reopened.stdout) as {
					ok?: boolean;
					previousColumnId?: string;
					movedToBacklog?: boolean;
					task?: {
						column?: string;
						process?: {
							stageId?: string;
							status?: string;
							history?: Array<{
								recordKind?: string;
								stageId?: string;
								targetStageId?: string;
								agent?: string;
								notes?: string;
							}>;
						} | null;
					};
				};
				expect(reopenedPayload).toMatchObject({
					ok: true,
					previousColumnId: "trash",
					movedToBacklog: true,
					task: {
						column: "backlog",
						process: {
							stageId: "pending",
							status: "ready",
						},
					},
				});
				expect(reopenedPayload.task?.process?.history?.at(-1)).toMatchObject({
					recordKind: "reopen",
					stageId: "reopened",
					targetStageId: "pending",
					agent: "pm",
					notes: "reopen completed process",
				});

				const passedAfterReopen = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						reopenTaskId ?? "",
						"--notes",
						"pass after reopen",
						"--agent",
						"pm",
						"--expected-stage",
						"pending",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					passedAfterReopen.didExit,
					`task process pass after reopen did not exit.\nstdout:\n${passedAfterReopen.stdout}\nstderr:\n${passedAfterReopen.stderr}`,
				).toBe(true);
				expect(passedAfterReopen.exitCode).toBe(0);
				const passedAfterReopenPayload = JSON.parse(passedAfterReopen.stdout) as {
					ok?: boolean;
					process?: { stageId?: string; status?: string };
				};
				expect(passedAfterReopenPayload).toMatchObject({
					ok: true,
					process: {
						stageId: "swe",
						status: "ready",
					},
				});

				const staleExpectedStage = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						taskId ?? "",
						"--notes",
						"stale stage should fail",
						"--agent",
						"cli-test",
						"--expected-stage",
						"swe",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					staleExpectedStage.didExit,
					`stale task process pass did not exit.\nstdout:\n${staleExpectedStage.stdout}\nstderr:\n${staleExpectedStage.stderr}`,
				).toBe(true);
				expect(staleExpectedStage.exitCode).not.toBe(0);
				const staleExpectedStagePayload = JSON.parse(staleExpectedStage.stdout) as {
					ok?: boolean;
					error?: string;
				};
				expect(staleExpectedStagePayload.ok).toBe(false);
				expect(staleExpectedStagePayload.error).toContain(
					`Task "${taskId}" is at process stage "research", expected "swe".`,
				);

				const listed = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listed.didExit,
					`task list did not exit.\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
				).toBe(true);
				expect(listed.exitCode).toBe(0);
				const listedPayload = JSON.parse(listed.stdout) as {
					tasks?: Array<{
						id?: string;
						process?: {
							stageId?: string;
							history?: Array<{
								recordKind?: string;
								stageId?: string;
								targetStageId?: string;
								verdict?: string;
								agent?: string;
							}>;
						} | null;
					}>;
				};
				const listedTask = listedPayload.tasks?.find((task) => task.id === taskId);
				expect(listedTask?.process?.stageId).toBe("research");
				expect(listedTask?.process?.history?.filter((entry) => entry.recordKind === "outcome")).toHaveLength(2);
				expect(listedTask?.process?.history).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ recordKind: "dispatch", stageId: "pending", targetStageId: "swe" }),
						expect.objectContaining({ recordKind: "dispatch", stageId: "swe" }),
					]),
				);
				expect(listedTask?.process?.history?.at(-1)).toMatchObject({
					recordKind: "outcome",
					stageId: "swe",
					targetStageId: "research",
					verdict: "fail",
					agent: "user",
				});

				const removedProcess = await runCliCommandAndCollectOutput({
					args: ["task", "process", "remove", "--process", "removable-process", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					removedProcess.didExit,
					`task process remove did not exit.\nstdout:\n${removedProcess.stdout}\nstderr:\n${removedProcess.stderr}`,
				).toBe(true);
				expect(removedProcess.exitCode).toBe(0);
				const removedProcessPayload = JSON.parse(removedProcess.stdout) as {
					ok?: boolean;
					removedProcessId?: string;
					customCount?: number;
				};
				expect(removedProcessPayload).toMatchObject({
					ok: true,
					removedProcessId: "removable-process",
					customCount: 1,
				});

				const assignedProcessRemove = await runCliCommandAndCollectOutput({
					args: ["task", "process", "remove", "--process", "cli-process", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					assignedProcessRemove.didExit,
					`assigned task process remove did not exit.\nstdout:\n${assignedProcessRemove.stdout}\nstderr:\n${assignedProcessRemove.stderr}`,
				).toBe(true);
				expect(assignedProcessRemove.exitCode).not.toBe(0);
				const assignedProcessRemovePayload = JSON.parse(assignedProcessRemove.stdout) as {
					ok?: boolean;
					error?: string;
				};
				expect(assignedProcessRemovePayload.ok).toBe(false);
				expect(assignedProcessRemovePayload.error).toContain(
					'Custom process "cli-process" is assigned to 2 tasks and cannot be removed.',
				);

				const replacementProcessJsonPath = join(projectPath, "replacement-process.json");
				writeFileSync(
					replacementProcessJsonPath,
					`${JSON.stringify(
						{
							schemaVersion: 1,
							id: "replacement-process",
							name: "Replacement Process",
							initial: "pending",
							states: {
								pending: { label: "Pending", on: { pass: "done" } },
								done: { label: "Done", terminal: true, on: {} },
							},
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const replaceAssignedProcess = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"import",
						"--file",
						replacementProcessJsonPath,
						"--replace",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					replaceAssignedProcess.didExit,
					`task process import --replace did not exit.\nstdout:\n${replaceAssignedProcess.stdout}\nstderr:\n${replaceAssignedProcess.stderr}`,
				).toBe(true);
				expect(replaceAssignedProcess.exitCode).not.toBe(0);
				const replaceAssignedProcessPayload = JSON.parse(replaceAssignedProcess.stdout) as {
					ok?: boolean;
					error?: string;
				};
				expect(replaceAssignedProcessPayload.ok).toBe(false);
				expect(replaceAssignedProcessPayload.error).toContain(
					'Custom process "cli-process" is assigned to 2 tasks and cannot be removed by --replace.',
				);

				const failTerminalProcessJsonPath = join(projectPath, "fail-terminal-process.json");
				writeFileSync(
					failTerminalProcessJsonPath,
					`${JSON.stringify(
						{
							schemaVersion: 1,
							id: "fail-terminal-process",
							name: "Fail Terminal Process",
							initial: "pending",
							states: {
								pending: {
									label: "Pending",
									prompt: "Fail this stage to complete the process for CLI completion parity testing.",
									on: { fail: "done" },
								},
								done: { label: "Done", terminal: true, on: {} },
							},
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const importedFailTerminalProcess = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"import",
						"--file",
						failTerminalProcessJsonPath,
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					importedFailTerminalProcess.didExit,
					`task process import fail-terminal did not exit.\nstdout:\n${importedFailTerminalProcess.stdout}\nstderr:\n${importedFailTerminalProcess.stderr}`,
				).toBe(true);
				expect(importedFailTerminalProcess.exitCode).toBe(0);

				const failTerminalTask = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a fail-terminal task for CLI completion parity testing",
						"--process",
						"fail-terminal-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					failTerminalTask.didExit,
					`task create fail-terminal did not exit.\nstdout:\n${failTerminalTask.stdout}\nstderr:\n${failTerminalTask.stderr}`,
				).toBe(true);
				expect(failTerminalTask.exitCode).toBe(0);
				const failTerminalTaskPayload = JSON.parse(failTerminalTask.stdout) as {
					task?: { id?: string };
				};
				const failTerminalTaskId = failTerminalTaskPayload.task?.id;
				expect(typeof failTerminalTaskId).toBe("string");

				const failedToTerminal = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"fail",
						"--task-id",
						failTerminalTaskId ?? "",
						"--notes",
						"terminal fail completes the process",
						"--agent",
						"cli-test",
						"--expected-stage",
						"pending",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					failedToTerminal.didExit,
					`task process fail terminal did not exit.\nstdout:\n${failedToTerminal.stdout}\nstderr:\n${failedToTerminal.stderr}`,
				).toBe(true);
				expect(failedToTerminal.exitCode).toBe(0);
				const failedToTerminalPayload = JSON.parse(failedToTerminal.stdout) as {
					ok?: boolean;
					completed?: boolean;
					movedToDone?: boolean;
					task?: { column?: string; process?: { stageId?: string; status?: string; lastVerdict?: string } | null };
				};
				expect(failedToTerminalPayload).toMatchObject({
					ok: true,
					completed: true,
					movedToDone: true,
					task: {
						column: "trash",
						process: {
							stageId: "done",
							status: "complete",
							lastVerdict: "fail",
						},
					},
				});
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("keeps a passed process stage ready when CLI handoff launch fails", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-process-handoff-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-process-handoff-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Process Handoff Test\n", "utf8");
			commitAll(projectPath, "init");

			const runtimeConfigDir = join(homeDir, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				`${JSON.stringify({ selectedAgentId: "codex" }, null, 2)}\n`,
				"utf8",
			);

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: "/usr/bin:/bin",
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const processJsonPath = join(projectPath, "handoff-process.json");
				writeFileSync(
					processJsonPath,
					`${JSON.stringify(
						{
							schemaVersion: 1,
							id: "handoff-process",
							name: "Handoff Process",
							initial: "pending",
							states: {
								pending: { label: "Pending", on: { pass: "swe" } },
								swe: {
									label: "SWE",
									role: "swe",
									agentId: "gemini",
									prompt: "Run the SWE stage and record a verdict.",
									on: { pass: "done", fail: "pending" },
								},
								done: { label: "Done", terminal: true, on: {} },
							},
						},
						null,
						2,
					)}\n`,
					"utf8",
				);

				const importedProcess = await runCliCommandAndCollectOutput({
					args: ["task", "process", "import", "--file", processJsonPath, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					importedProcess.didExit,
					`task process import did not exit.\nstdout:\n${importedProcess.stdout}\nstderr:\n${importedProcess.stderr}`,
				).toBe(true);
				expect(importedProcess.exitCode).toBe(0);

				const created = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a process-backed task for failed handoff testing",
						"--process",
						"handoff-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					created.didExit,
					`task create --process did not exit.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
				).toBe(true);
				expect(created.exitCode).toBe(0);
				const createdPayload = JSON.parse(created.stdout) as { task?: { id?: string } };
				const taskId = createdPayload.task?.id;
				expect(typeof taskId).toBe("string");

				const workspaceIndexPath = join(homeDir, ".cline", "kanban", "workspaces", "index.json");
				const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, "utf8")) as {
					repoPathToId?: Record<string, string>;
				};
				const workspaceIds = Object.values(workspaceIndex.repoPathToId ?? {});
				expect(workspaceIds).toHaveLength(1);
				const workspaceId = workspaceIds[0];
				expect(typeof workspaceId).toBe("string");
				const boardPath = join(homeDir, ".cline", "kanban", "workspaces", workspaceId ?? "", "board.json");
				const board = JSON.parse(readFileSync(boardPath, "utf8")) as {
					columns: Array<{ id: string; cards: Array<{ id: string }> }>;
				};
				const backlog = board.columns.find((column) => column.id === "backlog");
				const inProgress = board.columns.find((column) => column.id === "in_progress");
				expect(backlog).toBeDefined();
				expect(inProgress).toBeDefined();
				const taskIndex = backlog?.cards.findIndex((card) => card.id === taskId) ?? -1;
				expect(taskIndex).toBeGreaterThanOrEqual(0);
				const [card] = backlog?.cards.splice(taskIndex, 1) ?? [];
				expect(card).toBeDefined();
				if (!card) {
					throw new Error(`Task "${taskId}" could not be moved into in_progress for handoff testing.`);
				}
				inProgress?.cards.push(card);
				writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

				const passed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						taskId ?? "",
						"--notes",
						"pending passed but the stage agent is unavailable",
						"--agent",
						"cli-test",
						"--expected-stage",
						"pending",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
					timeoutMs: 12_000,
				});
				expect(
					passed.didExit,
					`task process pass did not exit.\nstdout:\n${passed.stdout}\nstderr:\n${passed.stderr}`,
				).toBe(true);
				expect(passed.exitCode).toBe(0);
				const passedPayload = JSON.parse(passed.stdout) as {
					ok?: boolean;
					process?: {
						stageId?: string;
						status?: string;
						progress?: { gatesPassed?: number; totalGates?: number; offPath?: boolean; reworkOf?: string | null };
						history?: Array<{ recordKind?: string; stageId?: string; notes?: string }>;
					};
					handoff?: { ok?: boolean; stageId?: string; error?: string } | null;
				};
				expect(passedPayload).toMatchObject({
					ok: true,
					process: {
						stageId: "swe",
						status: "ready",
						progress: {
							gatesPassed: 1,
							totalGates: 2,
							offPath: false,
							reworkOf: null,
						},
					},
					handoff: {
						ok: false,
						stageId: "swe",
					},
				});
				expect(passedPayload.handoff?.error).toContain("No runnable agent command is configured");
				expect(passedPayload.process?.history).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							recordKind: "append",
							stageId: "swe",
							notes: expect.stringContaining("Stage handoff failed: No runnable agent command is configured"),
						}),
					]),
				);

				const listed = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "in_progress", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listed.didExit,
					`task list did not exit.\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
				).toBe(true);
				expect(listed.exitCode).toBe(0);
				const listedPayload = JSON.parse(listed.stdout) as {
					tasks?: Array<{
						id?: string;
						process?: {
							stageId?: string;
							status?: string;
							progress?: { gatesPassed?: number; totalGates?: number; offPath?: boolean };
						} | null;
					}>;
				};
				const listedTask = listedPayload.tasks?.find((task) => task.id === taskId);
				expect(listedTask?.process).toMatchObject({
					stageId: "swe",
					status: "ready",
					progress: {
						gatesPassed: 1,
						totalGates: 2,
						offPath: false,
					},
				});
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("starts a fresh CLI agent from review for the next process stage after pass", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-process-handoff-success-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir(
			"kanban-project-task-process-handoff-success-",
		);

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Process Handoff Success Test\n", "utf8");
			commitAll(projectPath, "init");

			const runtimeConfigDir = join(homeDir, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				`${JSON.stringify({ selectedAgentId: "codex" }, null, 2)}\n`,
				"utf8",
			);

			const stubBinDir = join(homeDir, "agent-bin");
			const codexLogPath = join(homeDir, "codex-stub.log");
			mkdirSync(stubBinDir, { recursive: true });
			const codexStubPath = join(stubBinDir, "codex");
			writeFileSync(
				codexStubPath,
				`#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(codexLogPath)}
sleep 30
`,
				"utf8",
			);
			chmodSync(codexStubPath, 0o755);

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: `${stubBinDir}:/usr/bin:/bin`,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const processJsonPath = join(projectPath, "handoff-success-process.json");
				writeFileSync(
					processJsonPath,
					`${JSON.stringify(
						{
							schemaVersion: 1,
							id: "handoff-success-process",
							name: "Handoff Success Process",
							initial: "pending",
							states: {
								pending: { label: "Pending", on: { pass: "swe" } },
								swe: {
									label: "SWE",
									role: "swe",
									agentId: "codex",
									prompt: "Run the SWE stage from the stub agent and record a verdict.",
									on: { pass: "done", fail: "pending" },
								},
								done: { label: "Done", terminal: true, on: {} },
							},
						},
						null,
						2,
					)}\n`,
					"utf8",
				);

				const importedProcess = await runCliCommandAndCollectOutput({
					args: ["task", "process", "import", "--file", processJsonPath, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					importedProcess.didExit,
					`task process import did not exit.\nstdout:\n${importedProcess.stdout}\nstderr:\n${importedProcess.stderr}`,
				).toBe(true);
				expect(importedProcess.exitCode).toBe(0);

				const runReadyCreated = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a process-backed task for run-ready testing",
						"--process",
						"handoff-success-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					runReadyCreated.didExit,
					`task create run-ready fixture did not exit.\nstdout:\n${runReadyCreated.stdout}\nstderr:\n${runReadyCreated.stderr}`,
				).toBe(true);
				expect(runReadyCreated.exitCode).toBe(0);
				const runReadyCreatedPayload = JSON.parse(runReadyCreated.stdout) as { task?: { id?: string } };
				const runReadyTaskId = runReadyCreatedPayload.task?.id;
				expect(typeof runReadyTaskId).toBe("string");

				const runReady = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"run-ready",
						"--process",
						"handoff-success-process",
						"--stage",
						"swe",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
					timeoutMs: 12_000,
				});
				expect(
					runReady.didExit,
					`task process run-ready did not exit.\nstdout:\n${runReady.stdout}\nstderr:\n${runReady.stderr}`,
				).toBe(true);
				expect(runReady.exitCode).toBe(0);
				const runReadyPayload = JSON.parse(runReady.stdout) as {
					ok?: boolean;
					startedCount?: number;
					startedTaskIds?: string[];
					startedTasks?: Array<{
						id?: string;
						column?: string;
						process?: { stageId?: string; status?: string };
					}>;
				};
				expect(runReadyPayload).toMatchObject({
					ok: true,
					startedCount: 1,
					startedTaskIds: [runReadyTaskId],
					startedTasks: [
						{
							id: runReadyTaskId,
							column: "in_progress",
							process: {
								stageId: "swe",
								status: "running",
							},
						},
					],
				});

				const created = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a process-backed task for successful handoff testing",
						"--process",
						"handoff-success-process",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					created.didExit,
					`task create --process did not exit.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
				).toBe(true);
				expect(created.exitCode).toBe(0);
				const createdPayload = JSON.parse(created.stdout) as { task?: { id?: string } };
				const taskId = createdPayload.task?.id;
				expect(typeof taskId).toBe("string");

				const workspaceIndexPath = join(homeDir, ".cline", "kanban", "workspaces", "index.json");
				const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, "utf8")) as {
					repoPathToId?: Record<string, string>;
				};
				const workspaceIds = Object.values(workspaceIndex.repoPathToId ?? {});
				expect(workspaceIds).toHaveLength(1);
				const workspaceId = workspaceIds[0];
				if (!workspaceId) {
					throw new Error("Expected a persisted workspace id for successful handoff testing.");
				}
				const boardPath = join(homeDir, ".cline", "kanban", "workspaces", workspaceId, "board.json");
				const board = JSON.parse(readFileSync(boardPath, "utf8")) as {
					columns: Array<{ id: string; cards: Array<{ id: string }> }>;
				};
				const backlog = board.columns.find((column) => column.id === "backlog");
				const review = board.columns.find((column) => column.id === "review");
				if (!backlog || !review) {
					throw new Error("Expected backlog and review columns in persisted board state.");
				}
				const taskIndex = backlog.cards.findIndex((card) => card.id === taskId);
				expect(taskIndex).toBeGreaterThanOrEqual(0);
				const [card] = backlog.cards.splice(taskIndex, 1);
				if (!card) {
					throw new Error(`Task "${taskId}" could not be moved into review for handoff testing.`);
				}
				review.cards.push(card);
				writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

				const passed = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"process",
						"pass",
						"--task-id",
						taskId ?? "",
						"--notes",
						"pending passed and codex stub should launch",
						"--agent",
						"cli-test",
						"--expected-stage",
						"pending",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
					timeoutMs: 12_000,
				});
				expect(
					passed.didExit,
					`task process pass did not exit.\nstdout:\n${passed.stdout}\nstderr:\n${passed.stderr}`,
				).toBe(true);
				expect(passed.exitCode).toBe(0);
				const passedPayload = JSON.parse(passed.stdout) as {
					ok?: boolean;
					task?: { column?: string };
					process?: {
						stageId?: string;
						status?: string;
						progress?: { gatesPassed?: number; totalGates?: number; offPath?: boolean; reworkOf?: string | null };
					};
					handoff?: { ok?: boolean; stageId?: string; summary?: { state?: string; agentId?: string } } | null;
				};
				expect(passedPayload).toMatchObject({
					ok: true,
					task: {
						column: "in_progress",
					},
					process: {
						stageId: "swe",
						status: "running",
						progress: {
							gatesPassed: 1,
							totalGates: 2,
							offPath: false,
							reworkOf: null,
						},
					},
					handoff: {
						ok: true,
						stageId: "swe",
						summary: {
							state: "running",
							agentId: "codex",
						},
					},
				});

				const logStartedAt = Date.now();
				while (!existsSync(codexLogPath) && Date.now() - logStartedAt < 2_000) {
					await new Promise<void>((resolveWait) => {
						setTimeout(resolveWait, 25);
					});
				}
				expect(existsSync(codexLogPath)).toBe(true);
				expect(readFileSync(codexLogPath, "utf8")).toContain(
					"Run the SWE stage from the stub agent and record a verdict.",
				);

				const listed = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "in_progress", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listed.didExit,
					`task list did not exit.\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
				).toBe(true);
				expect(listed.exitCode).toBe(0);
				const listedPayload = JSON.parse(listed.stdout) as {
					tasks?: Array<{
						id?: string;
						process?: {
							stageId?: string;
							status?: string;
							progress?: { gatesPassed?: number; totalGates?: number; offPath?: boolean };
						} | null;
					}>;
				};
				const listedTask = listedPayload.tasks?.find((task) => task.id === taskId);
				expect(listedTask?.process).toMatchObject({
					stageId: "swe",
					status: "running",
					progress: {
						gatesPassed: 1,
						totalGates: 2,
						offPath: false,
					},
				});
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it(
		"auto-starts process-backed dependency tasks when a prerequisite moves to done",
		{ timeout: 60_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-process-dependency-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir(
				"kanban-project-task-process-dependency-",
			);

			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# Task Process Dependency Test\n", "utf8");
				commitAll(projectPath, "init");

				const runtimeConfigDir = join(homeDir, ".cline", "kanban");
				mkdirSync(runtimeConfigDir, { recursive: true });
				writeFileSync(
					join(runtimeConfigDir, "config.json"),
					`${JSON.stringify({ selectedAgentId: "codex" }, null, 2)}\n`,
					"utf8",
				);

				const stubBinDir = join(homeDir, "agent-bin");
				const codexLogPath = join(homeDir, "codex-dependency-stub.log");
				mkdirSync(stubBinDir, { recursive: true });
				const codexStubPath = join(stubBinDir, "codex");
				writeFileSync(
					codexStubPath,
					`#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(codexLogPath)}
sleep 30
`,
					"utf8",
				);
				chmodSync(codexStubPath, 0o755);

				const port = String(await getAvailablePort());
				const env = createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: port,
					PATH: `${stubBinDir}:/usr/bin:/bin`,
				});

				const serverProcess = spawn(
					process.execPath,
					[
						"--require",
						resolveShutdownIpcHookPath(),
						"--import",
						resolveTsxLoaderImportSpecifier(),
						resolve(process.cwd(), "src/cli.ts"),
						"--no-open",
					],
					{
						cwd: projectPath,
						env,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				);

				try {
					await waitForServerStart(serverProcess);

					const processJsonPath = join(projectPath, "dependency-process.json");
					writeFileSync(
						processJsonPath,
						`${JSON.stringify(
							{
								schemaVersion: 1,
								id: "dependency-process",
								name: "Dependency Process",
								initial: "pending",
								states: {
									pending: { label: "Pending", on: { pass: "swe" } },
									swe: {
										label: "SWE",
										role: "swe",
										agentId: "codex",
										prompt: "Run the dependent SWE stage after prerequisite completion.",
										on: { pass: "done", fail: "pending" },
									},
									done: { label: "Done", terminal: true, on: {} },
								},
							},
							null,
							2,
						)}\n`,
						"utf8",
					);

					const importedProcess = await runCliCommandAndCollectOutput({
						args: ["task", "process", "import", "--file", processJsonPath, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						importedProcess.didExit,
						`task process import did not exit.\nstdout:\n${importedProcess.stdout}\nstderr:\n${importedProcess.stderr}`,
					).toBe(true);
					expect(importedProcess.exitCode).toBe(0);

					const parentCreated = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							"Create prerequisite task for dependency process launch testing",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						parentCreated.didExit,
						`parent task create did not exit.\nstdout:\n${parentCreated.stdout}\nstderr:\n${parentCreated.stderr}`,
					).toBe(true);
					expect(parentCreated.exitCode).toBe(0);
					const parentCreatedPayload = JSON.parse(parentCreated.stdout) as { task?: { id?: string } };
					const parentTaskId = parentCreatedPayload.task?.id;
					expect(typeof parentTaskId).toBe("string");

					const dependentCreated = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							"Create process-backed dependent task for dependency launch testing",
							"--process",
							"dependency-process",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						dependentCreated.didExit,
						`dependent task create did not exit.\nstdout:\n${dependentCreated.stdout}\nstderr:\n${dependentCreated.stderr}`,
					).toBe(true);
					expect(dependentCreated.exitCode).toBe(0);
					const dependentCreatedPayload = JSON.parse(dependentCreated.stdout) as {
						task?: { id?: string; process?: { stageId?: string; status?: string } | null };
					};
					const dependentTaskId = dependentCreatedPayload.task?.id;
					expect(typeof dependentTaskId).toBe("string");
					expect(dependentCreatedPayload.task?.process).toMatchObject({
						stageId: "pending",
						status: "ready",
					});
					if (!parentTaskId || !dependentTaskId) {
						throw new Error("Expected parent and dependent task ids.");
					}

					const workspaceIndexPath = join(homeDir, ".cline", "kanban", "workspaces", "index.json");
					const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, "utf8")) as {
						repoPathToId?: Record<string, string>;
					};
					const workspaceIds = Object.values(workspaceIndex.repoPathToId ?? {});
					expect(workspaceIds).toHaveLength(1);
					const workspaceId = workspaceIds[0];
					if (!workspaceId) {
						throw new Error("Expected a persisted workspace id for dependency process testing.");
					}
					const boardPath = join(homeDir, ".cline", "kanban", "workspaces", workspaceId, "board.json");
					const board = JSON.parse(readFileSync(boardPath, "utf8")) as {
						columns: Array<{ id: string; cards: Array<{ id: string }> }>;
					};
					const backlog = board.columns.find((column) => column.id === "backlog");
					const review = board.columns.find((column) => column.id === "review");
					if (!backlog || !review) {
						throw new Error("Expected backlog and review columns in persisted board state.");
					}
					const parentTaskIndex = backlog.cards.findIndex((card) => card.id === parentTaskId);
					expect(parentTaskIndex).toBeGreaterThanOrEqual(0);
					const [parentCard] = backlog.cards.splice(parentTaskIndex, 1);
					if (!parentCard) {
						throw new Error(`Task "${parentTaskId}" could not be moved into review for dependency testing.`);
					}
					review.cards.push(parentCard);
					writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

					const linked = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"link",
							"--task-id",
							dependentTaskId,
							"--linked-task-id",
							parentTaskId,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						linked.didExit,
						`task link did not exit.\nstdout:\n${linked.stdout}\nstderr:\n${linked.stderr}`,
					).toBe(true);
					expect(linked.exitCode).toBe(0);
					const linkedPayload = JSON.parse(linked.stdout) as {
						ok?: boolean;
						dependency?: { backlogTaskId?: string; linkedTaskId?: string };
					};
					expect(linkedPayload).toMatchObject({
						ok: true,
						dependency: {
							backlogTaskId: dependentTaskId,
							linkedTaskId: parentTaskId,
						},
					});

					const blockedStart = await runCliCommandAndCollectOutput({
						args: ["task", "start", "--task-id", dependentTaskId, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						blockedStart.didExit,
						`blocked task start did not exit.\nstdout:\n${blockedStart.stdout}\nstderr:\n${blockedStart.stderr}`,
					).toBe(true);
					expect(blockedStart.exitCode).not.toBe(0);
					const blockedStartPayload = JSON.parse(blockedStart.stdout) as { ok?: boolean; error?: string };
					expect(blockedStartPayload.ok).toBe(false);
					expect(blockedStartPayload.error).toContain(
						`Task "${dependentTaskId}" is blocked by unfinished dependency task: ${parentTaskId}.`,
					);

					const done = await runCliCommandAndCollectOutput({
						args: ["task", "done", "--task-id", parentTaskId, "--project-path", projectPath],
						cwd: projectPath,
						env,
						timeoutMs: 12_000,
					});
					expect(done.didExit, `task done did not exit.\nstdout:\n${done.stdout}\nstderr:\n${done.stderr}`).toBe(
						true,
					);
					expect(done.exitCode).toBe(0);
					const donePayload = JSON.parse(done.stdout) as {
						ok?: boolean;
						readyTaskIds?: string[];
						autoStartedTasks?: Array<{
							ok?: boolean;
							task?: {
								id?: string;
								column?: string;
								process?: {
									stageId?: string;
									status?: string;
									progress?: {
										gatesPassed?: number;
										totalGates?: number;
										offPath?: boolean;
										reworkOf?: string | null;
									};
								} | null;
							};
						}>;
					};
					expect(donePayload.readyTaskIds).toEqual([dependentTaskId]);
					expect(donePayload.autoStartedTasks).toHaveLength(1);
					expect(donePayload.autoStartedTasks?.[0]).toMatchObject({
						ok: true,
						task: {
							id: dependentTaskId,
							column: "in_progress",
							process: {
								stageId: "swe",
								status: "running",
								progress: {
									gatesPassed: 1,
									totalGates: 2,
									offPath: false,
									reworkOf: null,
								},
							},
						},
					});

					const logStartedAt = Date.now();
					while (!existsSync(codexLogPath) && Date.now() - logStartedAt < 2_000) {
						await new Promise<void>((resolveWait) => {
							setTimeout(resolveWait, 25);
						});
					}
					expect(existsSync(codexLogPath)).toBe(true);
					expect(readFileSync(codexLogPath, "utf8")).toContain(
						"Run the dependent SWE stage after prerequisite completion.",
					);

					const listed = await runCliCommandAndCollectOutput({
						args: ["task", "list", "--column", "in_progress", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						listed.didExit,
						`task list did not exit.\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
					).toBe(true);
					expect(listed.exitCode).toBe(0);
					const listedPayload = JSON.parse(listed.stdout) as {
						tasks?: Array<{
							id?: string;
							process?: {
								stageId?: string;
								status?: string;
								progress?: { gatesPassed?: number; totalGates?: number; offPath?: boolean };
								history?: Array<{ recordKind?: string; stageId?: string; notes?: string }>;
							} | null;
						}>;
					};
					const listedTask = listedPayload.tasks?.find((task) => task.id === dependentTaskId);
					expect(listedTask?.process).toMatchObject({
						stageId: "swe",
						status: "running",
						progress: {
							gatesPassed: 1,
							totalGates: 2,
							offPath: false,
						},
					});
				} finally {
					await requestGracefulShutdown(serverProcess);
					const stopped = await waitForExit(serverProcess, 5_000);
					if (!stopped) {
						serverProcess.kill("SIGKILL");
						await waitForExit(serverProcess, 5_000);
					}
				}
			} finally {
				cleanupProject();
				cleanupHome();
			}
		},
	);

	it(
		"auto-starts dependency tasks when an in-progress process pass reaches terminal",
		{ timeout: 60_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-process-terminal-dependency-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir(
				"kanban-project-task-process-terminal-dependency-",
			);

			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# Task Process Terminal Dependency Test\n", "utf8");
				commitAll(projectPath, "init");

				const runtimeConfigDir = join(homeDir, ".cline", "kanban");
				mkdirSync(runtimeConfigDir, { recursive: true });
				writeFileSync(
					join(runtimeConfigDir, "config.json"),
					`${JSON.stringify({ selectedAgentId: "codex" }, null, 2)}\n`,
					"utf8",
				);

				const stubBinDir = join(homeDir, "agent-bin");
				const codexLogPath = join(homeDir, "codex-terminal-dependency-stub.log");
				mkdirSync(stubBinDir, { recursive: true });
				const codexStubPath = join(stubBinDir, "codex");
				writeFileSync(
					codexStubPath,
					`#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${JSON.stringify(codexLogPath)}
sleep 30
`,
					"utf8",
				);
				chmodSync(codexStubPath, 0o755);

				const port = String(await getAvailablePort());
				const env = createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: port,
					PATH: `${stubBinDir}:/usr/bin:/bin`,
				});

				const serverProcess = spawn(
					process.execPath,
					[
						"--require",
						resolveShutdownIpcHookPath(),
						"--import",
						resolveTsxLoaderImportSpecifier(),
						resolve(process.cwd(), "src/cli.ts"),
						"--no-open",
					],
					{
						cwd: projectPath,
						env,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				);

				try {
					await waitForServerStart(serverProcess);

					const processJsonPath = join(projectPath, "terminal-dependency-processes.json");
					writeFileSync(
						processJsonPath,
						`${JSON.stringify(
							[
								{
									schemaVersion: 1,
									id: "terminal-parent-process",
									name: "Terminal Parent Process",
									initial: "pending",
									states: {
										pending: { label: "Pending", on: { pass: "done" } },
										done: { label: "Done", terminal: true, on: {} },
									},
								},
								{
									schemaVersion: 1,
									id: "terminal-dependent-process",
									name: "Terminal Dependent Process",
									initial: "pending",
									states: {
										pending: { label: "Pending", on: { pass: "swe" } },
										swe: {
											label: "SWE",
											role: "swe",
											agentId: "codex",
											prompt: "Run the dependent stage after terminal process pass.",
											on: { pass: "done", fail: "pending" },
										},
										done: { label: "Done", terminal: true, on: {} },
									},
								},
							],
							null,
							2,
						)}\n`,
						"utf8",
					);

					const importedProcess = await runCliCommandAndCollectOutput({
						args: ["task", "process", "import", "--file", processJsonPath, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						importedProcess.didExit,
						`task process import did not exit.\nstdout:\n${importedProcess.stdout}\nstderr:\n${importedProcess.stderr}`,
					).toBe(true);
					expect(importedProcess.exitCode).toBe(0);

					const parentCreated = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							"Create process terminal prerequisite for dependency release testing",
							"--process",
							"terminal-parent-process",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						parentCreated.didExit,
						`parent task create did not exit.\nstdout:\n${parentCreated.stdout}\nstderr:\n${parentCreated.stderr}`,
					).toBe(true);
					expect(parentCreated.exitCode).toBe(0);
					const parentCreatedPayload = JSON.parse(parentCreated.stdout) as { task?: { id?: string } };
					const parentTaskId = parentCreatedPayload.task?.id;
					expect(typeof parentTaskId).toBe("string");

					const secondParentCreated = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							"Create second process terminal prerequisite for dependency release testing",
							"--process",
							"terminal-parent-process",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						secondParentCreated.didExit,
						`second parent task create did not exit.\nstdout:\n${secondParentCreated.stdout}\nstderr:\n${secondParentCreated.stderr}`,
					).toBe(true);
					expect(secondParentCreated.exitCode).toBe(0);
					const secondParentCreatedPayload = JSON.parse(secondParentCreated.stdout) as { task?: { id?: string } };
					const secondParentTaskId = secondParentCreatedPayload.task?.id;
					expect(typeof secondParentTaskId).toBe("string");

					const dependentCreated = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							"Create process-backed dependent task for terminal pass release testing",
							"--process",
							"terminal-dependent-process",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						dependentCreated.didExit,
						`dependent task create did not exit.\nstdout:\n${dependentCreated.stdout}\nstderr:\n${dependentCreated.stderr}`,
					).toBe(true);
					expect(dependentCreated.exitCode).toBe(0);
					const dependentCreatedPayload = JSON.parse(dependentCreated.stdout) as { task?: { id?: string } };
					const dependentTaskId = dependentCreatedPayload.task?.id;
					expect(typeof dependentTaskId).toBe("string");
					if (!parentTaskId || !secondParentTaskId || !dependentTaskId) {
						throw new Error("Expected parent, second parent, and dependent task ids.");
					}

					const workspaceIndexPath = join(homeDir, ".cline", "kanban", "workspaces", "index.json");
					const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, "utf8")) as {
						repoPathToId?: Record<string, string>;
					};
					const workspaceId = Object.values(workspaceIndex.repoPathToId ?? {})[0];
					if (!workspaceId) {
						throw new Error("Expected a persisted workspace id for terminal dependency process testing.");
					}
					const boardPath = join(homeDir, ".cline", "kanban", "workspaces", workspaceId, "board.json");
					const board = JSON.parse(readFileSync(boardPath, "utf8")) as {
						columns: Array<{ id: string; cards: Array<{ id: string }> }>;
					};
					const backlog = board.columns.find((column) => column.id === "backlog");
					const inProgress = board.columns.find((column) => column.id === "in_progress");
					if (!backlog || !inProgress) {
						throw new Error("Expected backlog and in_progress columns in persisted board state.");
					}
					const parentTaskIndex = backlog.cards.findIndex((card) => card.id === parentTaskId);
					expect(parentTaskIndex).toBeGreaterThanOrEqual(0);
					const [parentCard] = backlog.cards.splice(parentTaskIndex, 1);
					if (!parentCard) {
						throw new Error(`Task "${parentTaskId}" could not be moved into in_progress for dependency testing.`);
					}
					inProgress.cards.push(parentCard);
					const secondParentTaskIndex = backlog.cards.findIndex((card) => card.id === secondParentTaskId);
					expect(secondParentTaskIndex).toBeGreaterThanOrEqual(0);
					const [secondParentCard] = backlog.cards.splice(secondParentTaskIndex, 1);
					if (!secondParentCard) {
						throw new Error(
							`Task "${secondParentTaskId}" could not be moved into in_progress for dependency testing.`,
						);
					}
					inProgress.cards.push(secondParentCard);
					writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");

					const linked = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"link",
							"--task-id",
							dependentTaskId,
							"--linked-task-id",
							parentTaskId,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						linked.didExit,
						`task link did not exit.\nstdout:\n${linked.stdout}\nstderr:\n${linked.stderr}`,
					).toBe(true);
					expect(linked.exitCode).toBe(0);

					const secondLinked = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"link",
							"--task-id",
							dependentTaskId,
							"--linked-task-id",
							secondParentTaskId,
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						secondLinked.didExit,
						`second task link did not exit.\nstdout:\n${secondLinked.stdout}\nstderr:\n${secondLinked.stderr}`,
					).toBe(true);
					expect(secondLinked.exitCode).toBe(0);

					const passed = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"process",
							"pass",
							"--task-id",
							parentTaskId,
							"--notes",
							"terminal parent passed and should release dependent task",
							"--agent",
							"cli-test",
							"--expected-stage",
							"pending",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
						timeoutMs: 12_000,
					});
					expect(
						passed.didExit,
						`task process pass did not exit.\nstdout:\n${passed.stdout}\nstderr:\n${passed.stderr}`,
					).toBe(true);
					expect(passed.exitCode).toBe(0);
					const passedPayload = JSON.parse(passed.stdout) as {
						ok?: boolean;
						completed?: boolean;
						movedToDone?: boolean;
						readyTaskIds?: string[];
						autoStartedTasks?: Array<{
							ok?: boolean;
							task?: {
								id?: string;
								column?: string;
								process?: { stageId?: string; status?: string };
							};
						}>;
					};
					expect(passedPayload).toMatchObject({
						ok: true,
						completed: true,
						movedToDone: true,
						readyTaskIds: [],
						autoStartedTasks: [],
					});
					await new Promise<void>((resolveWait) => {
						setTimeout(resolveWait, 500);
					});
					expect(existsSync(codexLogPath)).toBe(false);

					const secondPassed = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"process",
							"pass",
							"--task-id",
							secondParentTaskId,
							"--notes",
							"second terminal parent passed and should release dependent task",
							"--agent",
							"cli-test",
							"--expected-stage",
							"pending",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
						timeoutMs: 12_000,
					});
					expect(
						secondPassed.didExit,
						`second task process pass did not exit.\nstdout:\n${secondPassed.stdout}\nstderr:\n${secondPassed.stderr}`,
					).toBe(true);
					expect(secondPassed.exitCode).toBe(0);
					const secondPassedPayload = JSON.parse(secondPassed.stdout) as {
						ok?: boolean;
						completed?: boolean;
						movedToDone?: boolean;
						readyTaskIds?: string[];
						autoStartedTasks?: Array<{
							ok?: boolean;
							task?: {
								id?: string;
								column?: string;
								process?: { stageId?: string; status?: string };
							};
						}>;
					};
					expect(secondPassedPayload).toMatchObject({
						ok: true,
						completed: true,
						movedToDone: true,
						readyTaskIds: [dependentTaskId],
						autoStartedTasks: [
							{
								ok: true,
								task: {
									id: dependentTaskId,
									column: "in_progress",
									process: {
										stageId: "swe",
										status: "running",
									},
								},
							},
						],
					});

					const logStartedAt = Date.now();
					while (!existsSync(codexLogPath) && Date.now() - logStartedAt < 2_000) {
						await new Promise<void>((resolveWait) => {
							setTimeout(resolveWait, 25);
						});
					}
					expect(existsSync(codexLogPath)).toBe(true);
					expect(readFileSync(codexLogPath, "utf8")).toContain(
						"Run the dependent stage after terminal process pass.",
					);
				} finally {
					await requestGracefulShutdown(serverProcess);
					const stopped = await waitForExit(serverProcess, 5_000);
					if (!stopped) {
						serverProcess.kill("SIGKILL");
						await waitForExit(serverProcess, 5_000);
					}
				}
			} finally {
				cleanupProject();
				cleanupHome();
			}
		},
	);

	it("supports done and trash aliases when moving and deleting tasks", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-done-delete-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-done-delete-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Done Delete Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const taskIds: string[] = [];
				for (const prompt of [
					"Create a temporary task for done and delete",
					"Create another temporary task for done and delete",
					"Create a legacy trash command task for done and delete",
				]) {
					const created = await runCliCommandAndCollectOutput({
						args: ["task", "create", "--prompt", prompt, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						created.didExit,
						`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
					).toBe(true);
					expect(created.exitCode).toBe(0);

					const createdPayload = JSON.parse(created.stdout) as {
						ok?: boolean;
						task?: { id?: string };
					};
					expect(createdPayload.ok).toBe(true);
					expect(typeof createdPayload.task?.id).toBe("string");
					if (createdPayload.task?.id) {
						taskIds.push(createdPayload.task.id);
					}
				}
				expect(taskIds).toHaveLength(3);

				const movedByDoneAlias = await runCliCommandAndCollectOutput({
					args: ["task", "done", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					movedByDoneAlias.didExit,
					`task done did not exit in time.\nstdout:\n${movedByDoneAlias.stdout}\nstderr:\n${movedByDoneAlias.stderr}`,
				).toBe(true);
				expect(movedByDoneAlias.exitCode).toBe(0);
				expect(movedByDoneAlias.stdout).toContain('"ok": true');

				const movedByTrashCommand = await runCliCommandAndCollectOutput({
					args: ["task", "trash", "--column", "backlog", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					movedByTrashCommand.didExit,
					`task trash did not exit in time.\nstdout:\n${movedByTrashCommand.stdout}\nstderr:\n${movedByTrashCommand.stderr}`,
				).toBe(true);
				expect(movedByTrashCommand.exitCode).toBe(0);
				expect(movedByTrashCommand.stdout).toContain('"ok": true');
				expect(movedByTrashCommand.stdout).toContain('"column": "backlog"');
				expect(movedByTrashCommand.stdout).toContain('"count": 2');

				const listedDoneBeforeDelete = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedDoneBeforeDelete.didExit,
					`task list --column done did not exit in time.\nstdout:\n${listedDoneBeforeDelete.stdout}\nstderr:\n${listedDoneBeforeDelete.stderr}`,
				).toBe(true);
				expect(listedDoneBeforeDelete.exitCode).toBe(0);
				expect(listedDoneBeforeDelete.stdout).toContain('"count": 3');

				const listedTrashBeforeDelete = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedTrashBeforeDelete.didExit,
					`task list --column trash did not exit in time.\nstdout:\n${listedTrashBeforeDelete.stdout}\nstderr:\n${listedTrashBeforeDelete.stderr}`,
				).toBe(true);
				expect(listedTrashBeforeDelete.exitCode).toBe(0);
				expect(listedTrashBeforeDelete.stdout).toContain('"count": 3');

				const deletedDone = await runCliCommandAndCollectOutput({
					args: ["task", "delete", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					deletedDone.didExit,
					`task delete --column done did not exit in time.\nstdout:\n${deletedDone.stdout}\nstderr:\n${deletedDone.stderr}`,
				).toBe(true);
				expect(deletedDone.exitCode).toBe(0);
				expect(deletedDone.stdout).toContain('"ok": true');
				expect(deletedDone.stdout).toContain('"column": "trash"');
				expect(deletedDone.stdout).toContain('"count": 3');

				const listedTrash = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedTrash.didExit,
					`task list --column trash did not exit in time.\nstdout:\n${listedTrash.stdout}\nstderr:\n${listedTrash.stderr}`,
				).toBe(true);
				expect(listedTrash.exitCode).toBe(0);
				expect(listedTrash.stdout).toContain('"count": 0');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("treats create-time reasoning inherit as no explicit override", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-cline-reasoning-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-cline-reasoning-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Cline Reasoning Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const inheritedCreate = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that inherits workspace reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"inherit",
					],
					cwd: projectPath,
					env,
				});
				expect(inheritedCreate.didExit).toBe(true);
				expect(inheritedCreate.exitCode).toBe(0);

				const inheritedPayload = JSON.parse(inheritedCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(inheritedPayload.ok).toBe(true);
				expect(inheritedPayload.task?.clineSettings).toBeUndefined();

				const defaultCreate = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that uses model default reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"default",
					],
					cwd: projectPath,
					env,
				});
				expect(defaultCreate.didExit).toBe(true);
				expect(defaultCreate.exitCode).toBe(0);

				const defaultPayload = JSON.parse(defaultCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(defaultPayload.ok).toBe(true);
				expect(defaultPayload.task?.clineSettings).toEqual({});
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
