import { DatabaseSync,backup } from 'node:sqlite';
import { existsSync,mkdirSync,copyFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { readConfig } from '../server.mjs';

const config=readConfig();
if(!existsSync(join(config.dataDir,'crm.sqlite')))throw new Error('没有可备份的数据库，请先启动项目。');
const target=resolve('backups',new Date().toISOString().replace(/[:.]/g,'-'));
mkdirSync(join(target,'uploads'),{recursive:true,mode:0o700});
const source=new DatabaseSync(join(config.dataDir,'crm.sqlite'),{readOnly:true});
try{
  await backup(source,join(target,'crm.sqlite'));
  const snapshot=new DatabaseSync(join(target,'crm.sqlite'),{readOnly:true});
  try{
    for(const image of snapshot.prepare('SELECT path FROM screenshots').all())copyFileSync(join(config.dataDir,image.path),join(target,image.path));
  }finally{snapshot.close();}
  writeFileSync(join(target,'RESTORE.txt'),'停止应用；将本目录的 crm.sqlite 和 uploads/ 复制到 DATA_DIR；不要保留旧 crm.sqlite-wal 或 crm.sqlite-shm；重新启动。备份可能包含客户隐私，请妥善保存。\n');
  console.log(`备份完成：${target}`);
}finally{source.close();}
