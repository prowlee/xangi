import type { ChildProcess } from 'child_process';

/**
 * 管理每个频道正在执行的进程
 */
class ProcessManager {
  private processes = new Map<string, ChildProcess>();

  /**
   * 注册进程
   */
  register(channelId: string, proc: ChildProcess): void {
    // 如果已存在进程，先终止它
    this.stop(channelId);
    this.processes.set(channelId, proc);

    // 进程结束时自动删除
    proc.on('close', () => {
      if (this.processes.get(channelId) === proc) {
        this.processes.delete(channelId);
      }
    });
  }

  /**
   * 停止进程
   * @returns 如果进程正在运行且已停止则返回 true
   */
  stop(channelId: string): boolean {
    const proc = this.processes.get(channelId);
    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      this.processes.delete(channelId);
      return true;
    }
    return false;
  }

  /**
   * 检查进程是否正在运行
   */
  isRunning(channelId: string): boolean {
    const proc = this.processes.get(channelId);
    return proc != null && !proc.killed;
  }

  /**
   * 停止所有进程
   */
  stopAll(): void {
    for (const [channelId] of this.processes) {
      this.stop(channelId);
    }
  }
}

// 单例模式
export const processManager = new ProcessManager();
