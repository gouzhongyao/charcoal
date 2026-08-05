import { download, request } from '@/api/http';

/** 读取系统启动信息；页面只展示白名单字段。 */
export const getSystemBootstrap = () => request({ url: '/bootstrap' });
/** 读取受控备份目录中的白名单备份。 */
export const getSystemBackups = () => request({ url: '/system/backups' });
/** 创建当前 SQLite 数据库的受控备份。 */
export const createSystemBackup = () => request({ method: 'post', url: '/system/backups' });
/** 恢复指定白名单备份；服务端维护态和完整性校验是最终边界。 */
export const restoreSystemBackup = (backupName) => request({ method: 'post', url: `/system/backups/${encodeURIComponent(backupName)}/restore` });
/** 删除指定白名单备份，不可用于删除当前数据库。 */
export const deleteSystemBackup = (backupName) => request({ method: 'delete', url: `/system/backups/${encodeURIComponent(backupName)}` });
/** 使用可信 HTTP 客户端下载备份，不拼接本地文件路径。 */
export const downloadSystemBackup = (backupName) => download({ url: `/system/backups/${encodeURIComponent(backupName)}/download` }, backupName);
