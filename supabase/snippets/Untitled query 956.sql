select 'apps' as table_name, count(*) from public.apps where tenant_id = '7a296850-6661-485e-95c7-0a0658b1d43c'
union all
select 'app_users', count(*) from public.app_users where tenant_id = '7a296850-6661-485e-95c7-0a0658b1d43c'
union all
select 'people', count(*) from public.people where tenant_id = '7a296850-6661-485e-95c7-0a0658b1d43c'
union all
select 'app_user_identity_matches', count(*) from public.app_user_identity_matches where tenant_id = '7a296850-6661-485e-95c7-0a0658b1d43c';