/** Atomic quota admission with expiring file and tenant claims, independent of process memory. */
export const CREATE_SESSION = `
local now = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now)
if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
if redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[6]) or redis.call('ZCARD', KEYS[5]) >= tonumber(ARGV[7]) then return -2 end
redis.call('PSETEX', KEYS[1], ARGV[3], ARGV[1])
redis.call('PSETEX', KEYS[2], ARGV[3], KEYS[1])
redis.call('PSETEX', KEYS[3], tonumber(ARGV[4])-now, ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[4], ARGV[2])
redis.call('ZADD', KEYS[5], ARGV[4], ARGV[2])
redis.call('PEXPIRE', KEYS[5], ARGV[3])
return 1`;

/** A revoked record cannot be revived by a stale save lease or a delayed status poll. */
export const PUT_SESSION = `
if redis.call('GET', KEYS[6]) ~= ARGV[8] then return -1 end
local previous = redis.call('GET', KEYS[1])
if not previous then return -2 end
local current = cjson.decode(previous)
local next = cjson.decode(ARGV[1])
if current.revoked and not next.revoked then return -3 end
if ARGV[6] == '1' and redis.call('GET', KEYS[3]) ~= ARGV[2] then return -4 end
redis.call('PSETEX', KEYS[1], ARGV[3], ARGV[1])
redis.call('PSETEX', KEYS[2], ARGV[3], KEYS[1])
if ARGV[6] == '1' then
  redis.call('PSETEX', KEYS[3], tonumber(ARGV[4])-tonumber(ARGV[5]), ARGV[2])
  redis.call('ZADD', KEYS[4], ARGV[4], ARGV[2])
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[2])
  redis.call('PEXPIRE', KEYS[5], ARGV[3])
else
  if redis.call('GET', KEYS[3]) == ARGV[2] then redis.call('DEL', KEYS[3]) end
  redis.call('ZREM', KEYS[4], ARGV[2])
  redis.call('ZREM', KEYS[5], ARGV[2])
end
return 1`;

/** Immediate revocation fences in-flight downloads without waiting for their save leases. */
export const REVOKE_SESSION = `
local previous = redis.call('GET', KEYS[1])
if not previous then return 0 end
local record = cjson.decode(previous)
record.revoked = true
if record.commitUnknown then record.state = 'save-failed' else record.state = 'closed' end
record.pending = nil
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('PSETEX', KEYS[1], ttl, cjson.encode(record))
if record.commitOwner or record.commitUnknown then return 2 end
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
return 1`;

/** Lease fencing always compares the opaque holder token, including renewal and release. */
export const ASSERT_LEASE = `-- lease:assert
if redis.call('GET', KEYS[1]) == ARGV[1] then return 1 end
return 0`;
export const RENEW_LEASE = `-- lease:renew
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[2])
if raw then
  local record = cjson.decode(raw)
  if record.commitOwner == ARGV[1] then
    if redis.call('GET', KEYS[3]) ~= record.id then return 0 end
    record.commitExpiresAt = tonumber(ARGV[3])+tonumber(ARGV[4])
    local ttl = redis.call('PTTL', KEYS[2])
    if ttl <= 0 then return 0 end
    redis.call('PSETEX', KEYS[2], ttl, cjson.encode(record))
    local expires = math.max(record.expiresAt, record.commitExpiresAt)
    redis.call('PEXPIRE', KEYS[3], expires-tonumber(ARGV[3]))
    redis.call('ZADD', KEYS[4], expires, record.id)
    redis.call('ZADD', KEYS[5], expires, record.id)
  end
end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])`;
export const RELEASE_LEASE = `-- lease:release
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
