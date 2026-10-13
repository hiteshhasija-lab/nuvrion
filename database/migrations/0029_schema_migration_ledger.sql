BEGIN;
-- The migration ledger. platform.schema_migrations has existed since 0001 but nothing ever wrote to it, so the readiness check could only look for a few
-- columns by hand and had no way to know which migrations were applied. From this migration on every migration records itself (an INSERT ... ON CONFLICT
-- DO NOTHING at its end, which tools/check-migrations.js requires), and readiness compares the newest recorded version with the newest migration file
-- that ships in the image.
--
-- 0001 to 0028 are recorded here, with the checksum of the file as it is in the repository. That is accurate because a release applies the migration its
-- manifest names only after the earlier releases applied theirs, in order; this one is applied by a release whose required migration is 0029.
INSERT INTO platform.schema_migrations (version, description, checksum) VALUES
  ('0001', 'platform foundation', 'c0d80cfb999a129b3d7cd52831e829b48c38f5adb2d755157308fd83256290d2'),
  ('0002', 'identity connections inventory', 'c25189d2b325009dbf4d24ae9532046531270d3845158022bf982fc244c1a267'),
  ('0003', 'tasks audit outbox', '82bf67c451fb2ee5282d9e8991d33af061734268fe118ef8d64eea482ba75c0a'),
  ('0004', 'inventory discovery', '1450df46832142d0caa8bcdb633924218fcfb34abbaa823498dd91a2bf758407'),
  ('0005', 'resource lifecycle operations', '7b8c25f3229ac9407213c98a13c259e78d060ec7fbb5617325fab697b2662401'),
  ('0006', 'production adapters', 'efd3d190441ebcd7bea527c86a35537a7c80a71a6e7d9ec0dda27e20da7111f6'),
  ('0007', 'persistent platform state', '9847bdd64502a32e52b4e6d4bb2544fbea29d23b54e3c6fa484e2a0c7664dba7'),
  ('0008', 'vmware provider', 'e04433732e3fdba489df5c2be3802d6be4c2c75893ad74ab2c6294318bc76d95'),
  ('0009', 'aws ec2 provider', '22400bbca4438b03c0d150b3f19204c5f9a34e2d036f35203ce56a0ade1a58c6'),
  ('0010', 'azure vm provider', 'f3fa214da896945c0213df805eb96bf96093ba6bc0d9f73dc71094e7a13d6003'),
  ('0011', 'workstation agents', '6bb4f5e64352ae6d2e5eb7162a908049dfc9ddd44646b5f267e06976e5f958f0'),
  ('0012', 'persistent agent registry', '210be8040aed0f5dec8a11eeb2515b303346f33ef9139a253043303c013cfa84'),
  ('0013', 'agent lifecycle controls', 'f6e22845f8e1b82d1cdb69dd9ac182bafac588aa509b5d88c6dc12cf0b137100'),
  ('0014', 'agent upgrades', '0ca339f808b795b18fafd30adbe721bc2877e2485abe5bd4e1864366d8eac88e'),
  ('0015', 'upgrade signing identity', '84d577052c40d993044cde980b8a6f7d10c0739f6eade6707bae8ac6f126d9cc'),
  ('0016', 'task retry safety', '235f23e4ac853ba653a7b6834f499f245927f2233649a534ae8d1fd06bc4ad67'),
  ('0017', 'identity lab recovery', '179cef891ab0f0fed74951e23f583a383194add9302e3b663d2ad0e92d3065c8'),
  ('0018', 'identity user administration', 'd2d5ed6ed2dc6ecc04fbc52aaa69cceab3b649cdbcdcc1ff4fa54e137f324655'),
  ('0019', 'workstation console commands', 'e38a23a1f3ca90cf2499f1a3a78402535fa6dafb8a28b91d3254fd977b11ad66'),
  ('0020', 'connection diagnostics', '4ca13d7d1b4af92f714014b65e28b3fbd1f347fc2701781b9fce117020f914ff'),
  ('0021', 'connection recovery state', 'a3f9f8893656630681df4acf83b21f21f9098af139c10c55a63a39f35ea0cca3'),
  ('0022', 'connection health alerts', 'fd7cf636baf5f6b5e714be13391bcd107f98eca32294f5e7b5ed4aaf20a990b3'),
  ('0023', 'vm performance metrics', '4be898c15b352a72ddee66520a3265eab6499a007685f183e045ba36d9ed488f'),
  ('0024', 'workstation pause commands', '0d5dcd54b57b517eb814777dc601c4c49c06056eeab081edec33f06b5da837a0'),
  ('0025', 'workstation media commands', '21e28d92fd5614455444eaceb9871bb7dd41cb73fc83279d38ad4cff9034d4c1'),
  ('0026', 'workstation reliability', 'cf17b84561c8c451011f41d455faba1afe2d0b1b6d75226cc5d1eee443788b0d'),
  ('0027', 'workstation guest restart', '6ad1885db6b6b8a295cb986d7010dc9788562da4ae9f3bf07483044c05de51ae'),
  ('0028', 'esxi performance metrics', '1d7ec16d8ed0012a849e079e97f09355a4f0e2eef69f57c2be5fa6a2c5b782e4')
ON CONFLICT (version) DO NOTHING;

INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0029', 'schema migration ledger', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
