import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBootstrap } from './bootstrap.js';

describe('bootstrap（L0 引导配置，facts §4.0）', () => {
  it('空 env：按 facts §4.0 记录默认值', () => {
    const c = readBootstrap({});
    expect(c.dataDir).toBe('./data');
    expect(c.dbPath).toBe(path.join('./data', 'opsgate.db'));
    expect(c.credentialKeyPath).toBe(path.join('./data', 'credentials.key'));
    expect(c.port).toBe(8080);
    expect(c.bind).toBe('127.0.0.1');
    expect(c.sessionSecret).toBeNull();
    expect(c.adminInit).toBeNull();
    expect(c.logLevel).toBe('info');
  });

  it('env 覆盖生效', () => {
    const c = readBootstrap({
      OPSGATE_DATA_DIR: '/srv/opsgate',
      OPSGATE_PORT: '9090',
      OPSGATE_BIND: '0.0.0.0',
      OPSGATE_LOG_LEVEL: 'debug',
      OPSGATE_ADMIN_INIT: 'admin@example.invalid',
      OPSGATE_SESSION_SECRET: 'test-secret',
    });
    expect(c.dataDir).toBe('/srv/opsgate');
    expect(c.dbPath).toBe(path.join('/srv/opsgate', 'opsgate.db'));
    expect(c.credentialKeyPath).toBe(path.join('/srv/opsgate', 'credentials.key'));
    expect(c.port).toBe(9090);
    expect(c.bind).toBe('0.0.0.0');
    expect(c.logLevel).toBe('debug');
    expect(c.adminInit).toBe('admin@example.invalid');
    expect(c.sessionSecret).toBe('test-secret');
  });

  it('非法端口 → 启动即失败（fail-fast）', () => {
    expect(() => readBootstrap({ OPSGATE_PORT: 'abc' })).toThrowError(/OPSGATE_PORT/);
    expect(() => readBootstrap({ OPSGATE_PORT: '99999' })).toThrowError(/OPSGATE_PORT/);
    expect(() => readBootstrap({ OPSGATE_PORT: '0' })).toThrowError(/OPSGATE_PORT/);
  });

  it('非法日志级别 → 启动即失败', () => {
    expect(() => readBootstrap({ OPSGATE_LOG_LEVEL: 'verbose' })).toThrowError(/OPSGATE_LOG_LEVEL/);
  });
});
