// ============================================================
// 模拟异步服务层
// 真实环境对应后端 API：统一延迟；解析/对账引擎为纯函数，可整体平移到服务端。
// 防过期响应由调用方持有"请求序号"做竞态控制，不依赖服务端。
// ============================================================

function delay<T>(value: T, ms = 420): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function simulateAsync<T>(factory: () => T, ms = 420): Promise<T> {
  return delay(0, ms).then(factory);
}

/**
 * 请求序号守卫：筛选/导入快速切换时，只有最新一次请求允许落库。
 * 旧请求 resolve 时 accepted=false，调用方必须丢弃该响应。
 */
export class RequestSeq<T> {
  private current = 0;

  async run(factory: () => Promise<T>): Promise<{ data: T; accepted: boolean }> {
    const token = ++this.current;
    const data = await factory();
    return { data, accepted: token === this.current };
  }

  get latestToken(): number {
    return this.current;
  }
}
