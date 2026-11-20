import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { check, configPath, context, samePath } from './repository.mjs';

try {
  const args = process.argv.slice(2);
  const ctx = context(dirname(configPath));
  if (args[0] === '--binding') {
    const [, selected] = args.splice(0, 2);
    check(selected && samePath(selected, ctx.file), '이 checkout의 자체 binding을 지정해야 한다.');
  }
  check(args.length, '사용법: launch.mjs [--binding 파일] 명령');
  // 이 checkout의 launcher가 직접 자식에 binding 출처를 전달한다.
  // workflow·정책·검증 실행기는 해당 binding의 검증된 release에서 읽는다.
  const watch = args[0] === 'watch-delivery';
  const script = join(ctx.root, 'bin', watch ? 'watch-delivery.mjs' : 'harness.mjs');
  const childArgs = watch ? [ctx.file, ...args.slice(1)] : ['--binding', ctx.file, ...args];
  const result = spawnSync(process.execPath, [script, ...childArgs], {
    cwd: ctx.root, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 2;
} catch (error) { console.error(error.message); process.exitCode = 2; }
