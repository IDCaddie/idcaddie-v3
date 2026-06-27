select
  u.email,
  tm.tenant_id,
  tm.role,
  tm.status
from auth.users u
join public.profiles p on p.id = u.id
join public.tenant_memberships tm on tm.user_id = p.id
where u.id = '35dccf96-4d93-4dc1-bed9-cba4451bd262';