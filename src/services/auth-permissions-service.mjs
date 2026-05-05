const ROLE_PERMISSIONS = {
  admin: ['*'],
  owner: [
    'dashboard.manager',
    'dashboard.rop',
    'dashboard.logistics',
    'dashboard.owner',
    'dashboard.data_quality',
    'dashboard.normalization',
    'dashboard.feedback_learning',
    'audit.view',
    'opportunity.view',
    'opportunity.decision',
    'opportunity.graph',
  ],
  rop: [
    'dashboard.manager',
    'dashboard.rop',
    'dashboard.data_quality',
    'dashboard.feedback_learning',
    'opportunity.view',
    'opportunity.decision',
    'opportunity.graph',
  ],
  sales_manager: [
    'dashboard.manager',
    'opportunity.view',
    'opportunity.decision',
    'opportunity.graph',
    'feedback.write',
  ],
  logistics: [
    'dashboard.logistics',
    'opportunity.view',
    'opportunity.graph',
  ],
};

function rolePermissions(roleCode) {
  return ROLE_PERMISSIONS[roleCode] ?? ROLE_PERMISSIONS.sales_manager;
}

export function resolveAuthContext(request) {
  const roleCode = String(request.headers['x-user-role'] ?? 'admin').trim().toLowerCase();

  return {
    user: {
      external_id: String(request.headers['x-user-id'] ?? `local-${roleCode}`),
      full_name: String(request.headers['x-user-name'] ?? 'Local Operator'),
      role_code: roleCode || 'sales_manager',
    },
    permissions: rolePermissions(roleCode || 'sales_manager'),
  };
}

export function requirePermission(auth, permission) {
  const permissions = auth?.permissions ?? [];
  if (permissions.includes('*') || permissions.includes(permission)) {
    return null;
  }

  return {
    error: 'Forbidden',
    message: `Role ${auth?.user?.role_code ?? 'unknown'} has no permission ${permission}`,
    required_permission: permission,
  };
}

