/**
 * 凭证结构性内容校验：kubeconfig / 私钥必须在源头拦下"明显坏掉"的格式。
 * 背景：编辑页原先把多行内容压成单行 input，用户改一个字就可能毁掉整份 YAML。
 */
import { describe, expect, it } from 'vitest';
import { validateCredentialValues, validateKubeconfig, validatePrivateKey } from './credentialValidation.js';

const GOOD_KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- name: c1
  cluster:
    server: https://10.0.0.1:6443
    insecure-skip-tls-verify: true
contexts:
- name: ctx1
  context:
    cluster: c1
    user: u1
current-context: ctx1
users:
- name: u1
  user:
    token: abc
`;

describe('kubeconfig 校验', () => {
  it('正常多行 kubeconfig 通过', () => {
    expect(validateKubeconfig(GOOD_KUBECONFIG)).toBeNull();
  });

  it('被压成一行 → 拒绝', () => {
    const squashed = GOOD_KUBECONFIG.replace(/\n\s*/g, ' ');
    expect(validateKubeconfig(squashed)).toMatch(/一行|kind: Config/);
  });

  it('使用 Tab 缩进 → 拒绝（YAML 不允许 Tab）', () => {
    const tabbed = GOOD_KUBECONFIG.replace('  cluster:', '\tcluster:');
    expect(validateKubeconfig(tabbed)).toMatch(/制表符/);
  });

  it('缺 users 段 → 拒绝', () => {
    const noUsers = GOOD_KUBECONFIG.slice(0, GOOD_KUBECONFIG.indexOf('users:'));
    expect(validateKubeconfig(noUsers)).toMatch(/users/);
  });

  it('空内容 → 拒绝', () => {
    expect(validateKubeconfig('')).toMatch(/为空/);
  });
});

describe('私钥校验', () => {
  it('正常 PEM 通过', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(validatePrivateKey(pem)).toBeNull();
  });

  it('缺 END 行 → 拒绝', () => {
    expect(validatePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA')).toMatch(/格式不正确/);
  });

  it('单行 → 拒绝', () => {
    expect(validatePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----AAAA-----END OPENSSH PRIVATE KEY-----')).toMatch(/一行/);
  });
});

describe('按凭证类型分派', () => {
  it('kubeconfig 类型只校验 kubeconfig 键', () => {
    expect(validateCredentialValues('kubeconfig', { kubeconfig: GOOD_KUBECONFIG })).toBeNull();
    expect(validateCredentialValues('kubeconfig', { kubeconfig: 'apiVersion: v1' })).toMatch(/kubeconfig/);
  });

  it('user_password 的 AUTH 若是普通密码，不做 PEM 校验', () => {
    expect(validateCredentialValues('user_password', { AUTH: 'plain-password' })).toBeNull();
  });

  it('ssh_key 类型的 AUTH 必须是 PEM', () => {
    expect(validateCredentialValues('ssh_key', { AUTH: 'not-a-key' })).toMatch(/私钥格式/);
  });

  it('ssh_key 的 username/passphrase 不按私钥校验（只有 AUTH 是私钥）', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(validateCredentialValues('ssh_key', { AUTH: pem, username: 'deploy', passphrase: 'p@ss' })).toBeNull();
  });
});
