import { useUserStore } from '@/stores/user';
import { hasPermission, isSuperAdmin } from '@/utils/permissionCore';
export { hasPermission, isSuperAdmin };

export function hasPermi(permission, permissions = null, profile = null) {
  const user = useUserStore();
  return hasPermission(permission, permissions || user.permissions, profile || user.profile);
}
