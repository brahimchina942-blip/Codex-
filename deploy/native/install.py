#!/usr/bin/env python3
"""Single-user CRM deployment beside an existing Nginx website. No website config is replaced."""
import argparse
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import posixpath
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request

DOMAIN = 'crm.sogreat.cc'
SERVER_IP = '8.209.58.190'
PORT = 3010
BASE = Path('/opt/morocco-ai-crm')
DATA = Path('/var/lib/morocco-ai-crm')
CONFIG = Path('/etc/morocco-ai-crm')
ACME = Path('/var/lib/morocco-ai-crm-acme')
USER = 'moroccocrm'
MARKER = '# Managed by Morocco AI CRM native deployment'
PACKAGE = Path(__file__).resolve().parent
APPLICATION = PACKAGE / 'app' if (PACKAGE / 'app/server.mjs').is_file() else PACKAGE.parent.parent
NODE_VERSION = '24.22.0'
NODE_HASHES = {
    'x64': 'cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008',
    'arm64': 'fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143',
}

def run(args, capture=False):
    return subprocess.run([str(x) for x in args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)

def atomic(path, text, mode=0o644):
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError('拒绝覆盖符号链接: ' + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.crm-tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def nginx_command():
    for process in Path('/proc').glob('[0-9]*/cmdline'):
        try:
            command = process.read_bytes().replace(b'\0', b' ').decode().strip()
        except (OSError, UnicodeError):
            continue
        if command.startswith('nginx: master process '):
            parts = shlex.split(command[len('nginx: master process '):])
            binary = os.readlink(process.parent / 'exe')
            result = [binary]
            for flag in ('-p', '-c'):
                if flag in parts:
                    result.extend([flag, parts[parts.index(flag) + 1]])
            return result
    binary = shutil.which('nginx')
    if not binary:
        raise RuntimeError('没有找到正在运行的Nginx。')
    return [binary]

def include_directory(config_dump):
    sections = re.split(r'^# configuration file (.+):\s*$', config_dump, flags=re.M)
    if len(sections) < 3:
        raise RuntimeError('无法识别Nginx主配置位置。')
    main, content = Path(sections[1]), sections[2]
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|#[^\n]*|[{};]|[^\s{};#]+', content)
    stack, statement = [], []
    for token in tokens:
        if token.startswith('#'):
            continue
        if token == '{':
            stack.append(statement[0] if statement else '')
            statement = []
        elif token == '}':
            if stack:
                stack.pop()
            statement = []
        elif token == ';':
            if stack == ['http'] and len(statement) == 2 and statement[0] == 'include':
                pattern = statement[1].strip('"\'')
                if pattern.endswith('/*.conf') and '$' not in pattern:
                    path = Path(pattern[:-7])
                    return path if path.is_absolute() else main.parent / path
            statement = []
        else:
            statement.append(token)
    raise RuntimeError('没有找到http层的独立*.conf包含目录；未修改Nginx，请提供nginx -V和include位置。')

def render_nginx(tls=False):
    challenge = f'location ^~ /.well-known/acme-challenge/ {{ root {ACME}; default_type text/plain; }}'
    if not tls:
        return f'''{MARKER}
server {{
    listen 80;
    server_name {DOMAIN};
    {challenge}
    location / {{ default_type text/plain; return 503 "CRM is being prepared. HTTPS is not enabled yet.\\n"; }}
}}
'''
    return f'''{MARKER}
server {{
    listen 80;
    server_name {DOMAIN};
    {challenge}
    location / {{ return 301 https://{DOMAIN}$request_uri; }}
}}
server {{
    listen 443 ssl;
    server_name {DOMAIN};
    ssl_certificate /etc/letsencrypt/live/{DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 46m;
    location / {{
        proxy_pass http://127.0.0.1:{PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 10s;
        proxy_read_timeout 190s;
        proxy_send_timeout 190s;
    }}
}}
'''

def render_service(node):
    return f'''{MARKER}
[Unit]
Description=Morocco AI CRM
After=network.target
[Service]
Type=simple
User={USER}
Group={USER}
WorkingDirectory={BASE}/current
EnvironmentFile={CONFIG}/app.env
ExecStart={node} {BASE}/current/server.mjs
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths={DATA}
[Install]
WantedBy=multi-user.target
'''

def managed(path):
    if path.exists() and (path.is_symlink() or not path.read_text().startswith(MARKER)):
        raise RuntimeError('发现非本安装器管理的文件，已保留: ' + str(path))

def install_nginx(command, destination, tls):
    managed(destination)
    previous = destination.read_bytes() if destination.exists() else None
    atomic(destination, render_nginx(tls))
    try:
        run(command + ['-t'])
        run(command + ['-s', 'reload'])
    except Exception:
        if previous is None:
            destination.unlink(missing_ok=True)
        else:
            atomic(destination, previous.decode())
        run(command + ['-t'])
        run(command + ['-s', 'reload'])
        raise

def website_status():
    connection = http.client.HTTPConnection('127.0.0.1', 80, timeout=8)
    try:
        connection.request('GET', '/', headers={'Host': 'sogreat.cc'})
        response = connection.getresponse()
        response.read(8192)
        return response.status, response.getheader('Location')
    finally:
        connection.close()

def app_status():
    connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=5)
    try:
        connection.request('GET', '/api/status', headers={'Host': DOMAIN})
        response = connection.getresponse()
        body = json.loads(response.read())
        if response.status != 200 or body.get('version') != '0.2.0' or not body.get('password_required'):
            raise RuntimeError('应用版本或密码保护检查失败。')
        return body
    finally:
        connection.close()

def prepare_node():
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(os.uname().machine)
    if not arch:
        raise RuntimeError('暂不支持服务器架构: ' + os.uname().machine)
    name = f'node-v{NODE_VERSION}-linux-{arch}'
    destination = PACKAGE / 'runtime' / name
    archive = PACKAGE / 'runtime' / (name + '.tar.xz')
    if not archive.exists():
        archive.parent.mkdir(parents=True, exist_ok=True)
        print('正在从Node.js官网取得已固定校验值的运行环境……', flush=True)
        request = urllib.request.Request(f'https://nodejs.org/dist/v{NODE_VERSION}/{name}.tar.xz')
        with urllib.request.urlopen(request, timeout=120) as source, archive.open('wb') as target:
            shutil.copyfileobj(source, target)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_HASHES[arch]:
        raise RuntimeError('Node.js官方SHA256校验失败，停止安装。')
    if destination.exists():
        with tarfile.open(archive) as tar:
            expected = hashlib.sha256(tar.extractfile(name + '/bin/node').read()).digest()
        node = destination / 'bin/node'
        if hashlib.sha256(node.read_bytes()).digest() != expected:
            raise RuntimeError('缓存的Node.js二进制校验失败。')
        return node
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        # The archive is pinned to a checksum retrieved from nodejs.org; reject escaping links as well.
        for member in tar.getmembers():
            if member.name.startswith('/') or '..' in Path(member.name).parts:
                raise RuntimeError('Node.js归档路径异常。')
            if member.issym() or member.islnk():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname)) if member.issym() else posixpath.normpath(member.linkname)
                if not target.startswith(name + '/'):
                    raise RuntimeError('Node.js归档链接异常。')
        tar.extractall(destination.parent)
    node = destination / 'bin/node'
    if run([node, '--version'], True).stdout.strip() != 'v' + NODE_VERSION:
        raise RuntimeError('Node.js版本检查失败。')
    return node

def install():
    command = nginx_command()
    run(command + ['-t'])
    before = website_status()
    for path in (BASE, DATA, CONFIG, ACME):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise RuntimeError('发现冲突路径，未修改: ' + str(path))
    output = run(command + ['-T'], True).stdout
    directory = include_directory(output)
    destination = directory / (DOMAIN + '.conf')
    managed(destination)
    for names in re.findall(r'\bserver_name\s+([^;]+);', output):
        if DOMAIN in names.split() and not destination.exists():
            raise RuntimeError('已发现该子域名的现有Nginx配置，停止以保留原配置。')
    unit = Path('/etc/systemd/system/morocco-ai-crm.service')
    managed(unit)
    if (CONFIG / 'state.json').exists():
        raise RuntimeError('发现已有CRM安装，已保留数据。使用 --status 查看，或 --https 继续证书配置；不重复安装。')
    if BASE.exists() and any(BASE.iterdir()):
        raise RuntimeError('目标目录非空，已停止以保护现有文件: ' + str(BASE))
    if DATA.exists() and any(DATA.iterdir()):
        raise RuntimeError('发现已有客户数据，已停止以避免未经备份的升级。')
    if (CONFIG / 'app.env').exists():
        raise RuntimeError('已有应用环境配置，已停止并保留。')
    with socket.socket() as s:
        s.bind(('127.0.0.1', PORT))
    if not (APPLICATION / 'server.mjs').is_file():
        raise RuntimeError('安装包缺少应用源码。')
    print('请设置网页访问密码（至少12位，输入时不显示；无需发给他人）。', flush=True)
    password = getpass.getpass('访问密码: ')
    if len(password) < 12 or any(c in password for c in '\r\n\0'):
        raise RuntimeError('密码至少12位，且不能包含换行。')
    if password != getpass.getpass('再次输入: '):
        raise RuntimeError('两次密码不同，未安装。')
    staged_node = prepare_node()
    run([staged_node, '--test', *sorted((APPLICATION / 'test').glob('*.test.mjs'))])
    runtime = BASE / 'runtime' / staged_node.parent.parent.name
    shutil.copytree(staged_node.parent.parent, runtime)
    node = runtime / 'bin/node'
    source = BASE / 'releases/v0.2.0'
    def omit(directory, names):
        excluded = {'.git', '.env', 'data', 'backups', 'node_modules', 'test-results', '__pycache__'}
        if Path(directory).resolve() == PACKAGE:
            excluded.add('runtime')
        return [name for name in names if name in excluded or name.endswith('.log')]
    shutil.copytree(APPLICATION, source, ignore=omit)
    shutil.copy2(__file__, BASE / 'manage.py')
    for directory in (BASE, BASE / 'runtime', BASE / 'releases', runtime):
        directory.chmod(0o755)
    for path in [source, *source.rglob('*')]:
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() else 0o644)
    try:
        account = pwd.getpwnam(USER)
        if account.pw_uid == 0 or Path(account.pw_dir) != DATA:
            raise RuntimeError('同名系统用户配置不符合要求，未修改现有用户。')
    except KeyError:
        run(['useradd', '--system', '--user-group', '--home-dir', DATA, '--shell', '/sbin/nologin', USER])
        account = pwd.getpwnam(USER)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA.chmod(0o700)
    os.chown(DATA, account.pw_uid, account.pw_gid)
    CONFIG.mkdir(parents=True, exist_ok=True, mode=0o700)
    env = {'HOST': '127.0.0.1', 'PORT': str(PORT), 'DATA_DIR': str(DATA),
           'APP_ORIGIN': 'https://' + DOMAIN, 'APP_PASSWORD': password}
    def quoted(value):
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
    atomic(CONFIG / 'app.env', ''.join(k + '=' + quoted(v) + '\n' for k, v in env.items()), 0o600)
    password = None
    (BASE / 'current').symlink_to(source)
    atomic(unit, render_service(node))
    ACME.mkdir(parents=True, exist_ok=True, mode=0o755)
    ACME.chmod(0o755)
    atomic(CONFIG / 'state.json', json.dumps({'nginx': command, 'site': str(destination), 'node': str(node)}, indent=2), 0o600)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'morocco-ai-crm'])
    for attempt in range(20):
        try:
            app_status()
            break
        except (OSError, ValueError, RuntimeError):
            if attempt == 19:
                raise RuntimeError('应用未通过启动检查，请查看 journalctl -u morocco-ai-crm -n 40。')
            time.sleep(1)
    install_nginx(command, destination, False)
    if website_status() != before:
        raise RuntimeError('现有官网的HTTP状态发生变化，请检查Nginx；未宣称上线。')
    print('应用已启动、密码保护通过，原官网HTTP状态保持一致。')
    print('HTTPS尚未配置，HTTP暂不开放登录。新增DNS A记录crm → ' + SERVER_IP + '后，运行本脚本 --https。')

def https():
    state = json.loads((CONFIG / 'state.json').read_text())
    app_status()
    addresses = {x[4][0] for x in socket.getaddrinfo(DOMAIN, 80)}
    if addresses != {SERVER_IP}:
        raise RuntimeError('DNS还未直接指向服务器，请检查crm的A/AAAA记录。当前: ' + ', '.join(addresses))
    token = os.urandom(16).hex()
    test = ACME / '.well-known/acme-challenge' / token
    test.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    for directory in (ACME, ACME / '.well-known', test.parent):
        directory.chmod(0o755)
    test.write_text(token)
    test.chmod(0o644)
    try:
        with urllib.request.urlopen(f'http://{DOMAIN}/.well-known/acme-challenge/{token}', timeout=15) as response:
            if response.read().decode() != token:
                raise RuntimeError('域名HTTP验证未返回本机校验内容。')
    finally:
        test.unlink(missing_ok=True)
    certbot = Path(shutil.which('certbot') or BASE / 'certbot/bin/certbot')
    if not certbot.exists():
        try:
            run([sys.executable, '-m', 'venv', BASE / 'certbot'])
        except subprocess.CalledProcessError:
            if not shutil.which('dnf'):
                raise RuntimeError('缺少Python venv/pip，请安装系统对应软件包后重试 --https。')
            run(['dnf', '-y', 'install', 'python3-pip'])
            run([sys.executable, '-m', 'venv', BASE / 'certbot'])
        run([BASE / 'certbot/bin/python', '-m', 'pip', 'install', '--disable-pip-version-check', 'certbot'])
    run([certbot, 'certonly', '--cert-name', DOMAIN, '--webroot', '-w', ACME, '-d', DOMAIN,
         '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--keep-until-expiring'])
    before = website_status()
    install_nginx(state['nginx'], Path(state['site']), True)
    if website_status() != before:
        raise RuntimeError('现有官网HTTP状态发生变化，请检查。')
    hook = shlex.join(state['nginx'] + ['-t']) + ' && ' + shlex.join(state['nginx'] + ['-s', 'reload'])
    renewal = Path('/etc/systemd/system/morocco-ai-crm-renew.service')
    timer = Path('/etc/systemd/system/morocco-ai-crm-renew.timer')
    managed(renewal)
    managed(timer)
    atomic(renewal, f'''{MARKER}
[Unit]
Description=Renew Morocco AI CRM TLS certificate
[Service]
Type=oneshot
ExecStart={certbot} renew --cert-name {DOMAIN} --quiet --deploy-hook "{hook}"
''')
    atomic(timer, f'''{MARKER}
[Unit]
Description=Daily CRM certificate renewal check
[Timer]
OnCalendar=daily
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
''')
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'morocco-ai-crm-renew.timer'])
    for attempt in range(10):
        try:
            with urllib.request.urlopen(f'https://{DOMAIN}/api/status', timeout=15) as response:
                result = json.load(response)
                if not result.get('password_required') or result.get('authenticated'):
                    raise RuntimeError('公网密码保护验证失败。')
            break
        except (OSError, ValueError):
            if attempt == 9:
                raise
            time.sleep(1)
    print('HTTPS与未登录保护已通过。请使用你设置的访问密码登录 https://' + DOMAIN)
    print('真实千问需另行配置百炼接口；固定示例不代表真实识别。')

def backup():
    state = json.loads((CONFIG / 'state.json').read_text())
    active = subprocess.run(['systemctl', 'is-active', '--quiet', 'morocco-ai-crm']).returncode == 0
    if active:
        run(['systemctl', 'stop', 'morocco-ai-crm'])
    try:
        command = f'cd {shlex.quote(str(DATA))} && DATA_DIR={shlex.quote(str(DATA))} {shlex.quote(state["node"])} {BASE}/current/scripts/backup.mjs'
        run(['runuser', '-u', USER, '--', '/bin/sh', '-c', command])
    finally:
        if active:
            run(['systemctl', 'start', 'morocco-ai-crm'])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--https', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--backup', action='store_true')
    args = parser.parse_args()
    if sum((args.install, args.https, args.status, args.backup)) != 1:
        parser.error('请选择 --install / --https / --status / --backup')
    if os.geteuid() != 0:
        raise RuntimeError('请以root执行。')
    if args.install:
        install()
    elif args.https:
        https()
    elif args.backup:
        backup()
    else:
        result = app_status()
        print(json.dumps({k: result.get(k) for k in ('version', 'password_required', 'qwen_configured')}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError, ValueError) as error:
        print('停止: ' + str(error), file=sys.stderr)
        sys.exit(1)
