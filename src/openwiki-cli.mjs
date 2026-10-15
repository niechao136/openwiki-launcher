import { spawn } from "node:child_process";
import { OpenwikiNotFoundError, resolveOpenwikiRuntime } from "./paths.mjs";
import { launcherPackageRoot } from "./versions.mjs";

/**
 * `ow` 的透传内核：把参数原样交给 launcher 自带的 openwiki CLI，
 * stdio / 信号 / 退出码全部透明。
 *
 * 两点是本模块的存在理由：
 *
 * 1. **必须用 `sourceCliJs`，不能用 `cliJs`**——后者在 bundle 就绪时是 MCP 后端
 *    的单文件入口，没有 CLI 命令分发能力；拿它跑 `visualize` 会在参数解析处直接崩。
 * 2. **stdio 继承**——openwiki 的交互式 agent（ink 渲染）与 `visualize` 的本地
 *    服务器都要求真实 TTY，任何管道包装都会破坏它们。
 *
 * @param {{
 *   args: string[],
 *   logger: object,
 *   pkgRoot?: string,
 *   resolveRuntime?: Function,
 *   spawnFn?: Function,
 * }} options
 * @returns {Promise<number>} openwiki 进程的退出码（被信号终结时为 1）
 */
export async function runOpenwikiCli({
  args,
  logger,
  pkgRoot = launcherPackageRoot(),
  resolveRuntime = resolveOpenwikiRuntime,
  spawnFn = spawn,
}) {
  let runtime;
  try {
    runtime = await resolveRuntime({ pkgRoot, logger });
  } catch (error) {
    // 软着陆：解析失败是用户可修复的状态（重跑安装器 / warm），不是异常栈。
    if (error instanceof OpenwikiNotFoundError) {
      logger.error(
        `未找到可用的 openwiki：请重跑安装器（owl install）或用 owl warm 物化默认版本（${error.message}）`,
      );
    } else {
      logger.error(`解析 openwiki 运行时失败：${error.message}（可用 owl install 重跑安装器修复）`);
    }
    return 1;
  }

  const child = spawnFn(process.execPath, [runtime.sourceCliJs, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  // POSIX 上父进程收到 Ctrl+C / kill 后要把信号转给子进程；Windows 上同一控制台
  // 进程组会天然同时收到，child.kill 不支持该信号时静默忽略。
  const forwarders = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const forward = () => {
      try {
        child.kill(signal);
      } catch {
        // 平台不支持该信号：忽略，靠进程组语义兜底。
      }
    };
    forwarders.set(signal, forward);
    process.on(signal, forward);
  }

  const code = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("close", (exitCode) => settle(exitCode ?? 1));
    // spawn 本身失败（入口在解析与 spawn 之间被删/被锁：并发 update、Defender
    // 扫描）时 Node emit 'error'——没有监听器就是未捕获异常，用户拿到裸栈，
    // 而解析阶段承诺的是可操作提示。这里必须同样软着陆。
    child.once("error", (error) => {
      logger.error(`启动 openwiki 失败：${error.message}（可跑 owl install 修复）`);
      settle(1);
    });
  });

  for (const [signal, forward] of forwarders) {
    process.removeListener(signal, forward);
  }
  return code;
}
