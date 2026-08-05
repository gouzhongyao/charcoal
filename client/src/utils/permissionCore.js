export function isSuperAdmin(profile = {}) {
  return profile?.roleCode === 'super_admin'
    || (Array.isArray(profile?.roles) && profile.roles.some((role) => role?.roleCode === 'super_admin'));
}

export function hasPermission(permission, permissions = [], profile = {}) {
  const required = Array.isArray(permission) ? permission : [permission];
  return isSuperAdmin(profile) || permissions.includes('*:*:*') || required.some((item) => permissions.includes(item));
}
