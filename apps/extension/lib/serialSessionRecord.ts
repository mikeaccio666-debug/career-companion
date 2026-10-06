/**
 * storage.session 里的一张表，读—改—写排成一队（2026-09-27）。
 *
 * 报到表、子帧持表表从前都是「读出来、改一条、整张写回去」：两次写入一交错，后写的那次就把先写的那条冲掉。
 * #115 起内容脚本全网注入、每个 https 页面都报到，几个标签页同时报到成了常事；被冲掉的那一页再问资料，
 * 后台答「这一页没登记」，资料编辑器画成「暂时读不到你的资料，稍后再试」（负责人在商店包上遇到）。
 *
 * 同一个 worker 实例里的写入排成一队；读也等前面的写完，所以刚报到完就问的那一页读得到自己。
 * worker 挂起再醒来是新的实例、新的一队——那时队里本来就没有别人。
 */
export interface SessionAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SerialSessionRecord<T> {
  /** 等前面排着的写完再读；存储读不出就按空值（`parse(undefined)`）。 */
  read(): Promise<T>;
  /** 排队读—改—写。存储坏了答 false（这一次没写上），之后的写照常排上。 */
  update(transform: (current: T) => T): Promise<boolean>;
}

export function createSerialSessionRecord<T>(
  area: () => SessionAreaLike,
  key: string,
  parse: (stored: unknown) => T,
): SerialSessionRecord<T> {
  let tail: Promise<unknown> = Promise.resolve();
  const readNow = async (): Promise<T> => {
    try {
      return parse((await area().get(key))[key]);
    } catch {
      // 读不出和没有是一回事：这张表只用来认「这一页报到过没有」，认不出就当没报到（fail closed）。
      return parse(undefined);
    }
  };
  return {
    read: () => tail.then(readNow, readNow),
    update(transform) {
      const run = tail.then(async () => {
        try {
          await area().set({ [key]: transform(await readNow()) });
          return true;
        } catch {
          return false;
        }
      });
      tail = run;
      return run;
    },
  };
}
