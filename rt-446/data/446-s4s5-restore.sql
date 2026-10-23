-- RT-446 S4/S5 restore: exact before-values from 446-s4s5-before.txt (price, is_active AND updated_at).
begin;
select set_config('app.current_tenant','9be1cac9-f6dc-4e0b-b2bb-6f4a4145801a',true);
update tenant_products set default_price = 7.2500, updated_at = '2026-09-27 21:55:10.464685+00' where id = 'a0573883-2c8c-4ac8-8329-d4722ba6b737' returning name, default_price, is_active, updated_at;
update tenant_products set is_active = true, updated_at = '2026-10-06 22:29:12.418384+00' where id = '1b0972cd-eecf-423b-90b6-0796317e4e69' returning name, default_price, is_active, updated_at;
commit;
