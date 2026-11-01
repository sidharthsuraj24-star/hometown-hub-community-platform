function isAuthorizedServiceRoleRequest(request, serviceRoleKey) {
  if (typeof serviceRoleKey !== 'string' || serviceRoleKey.length === 0) return false
  return request.headers.get('authorization') === `Bearer ${serviceRoleKey}` &&
    request.headers.get('apikey') === serviceRoleKey
}

export { isAuthorizedServiceRoleRequest }
