-- First owner configuration. The school domain, and the owner's school email as the first admin.
-- Change the admin address here before the first `migrations apply` if it differs (setup.md, step 4).
INSERT OR IGNORE INTO library_domains (domain) VALUES ('stjbs.sch.id');
INSERT OR IGNORE INTO library_admins (email, added_at, added_by) VALUES ('josef.yang@stjbs.sch.id', 0, 'migration');
