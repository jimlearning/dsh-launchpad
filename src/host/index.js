/**
 * dsh-launchpad host 入口。默认导出 Service 类；
 * loader 以 (ctx, config) 构造并注册到 `launchpad` 命名空间。
 */
import { LaunchpadService } from './service.js';

export default LaunchpadService;
export { LaunchpadService };
