// rest-load-test-rps.js
// 지속 부하 버전: 초당 일정 수의 유저를 계속 투입해서 목표 RPS를 유지하고,
// 지정한 시간 동안 지속. 각 유저는 가입→로그인→조회 반복→탈퇴 전체 흐름 수행.
//
// 사용법 (예: 초당 25명 투입, 유저당 조회 10회, 120초 지속):
//   node rest-load-test-rps.js --arrival=25 --loops=10 --think=300 --duration=120 \
//     --api-url=https://chat.goorm-ktb-003.goorm.team
//
// RPS 대략 계산: 정상상태에서 동시 유저 ≈ arrival × (유저 세션 길이)
//   유저 세션 길이 ≈ loops × think(초) + 가입/로그인/탈퇴 응답시간
//   실질 RPS는 실행 중 실시간 출력으로 확인하며 arrival/think를 조절하세요.

const axios = require('axios');

// ---------- 인자 파싱 ----------
const args = process.argv.slice(2).reduce((acc, cur) => {
    const [k, v] = cur.replace(/^--/, '').split('=');
    acc[k] = v;
    return acc;
}, {});

const ARRIVAL = parseInt(args['arrival'] || '25', 10);    // 초당 새로 투입할 유저 수
const LOOPS = parseInt(args['loops'] || '10', 10);        // 유저당 목록조회 반복 횟수
const THINK = parseInt(args['think'] || '300', 10);       // 조회 간 대기(ms)
const DURATION = parseInt(args['duration'] || '120', 10); // 유저 투입을 지속할 시간(초)
const API_URL = (args['api-url'] || 'https://chat.goorm-ktb-003.goorm.team').replace(/\/$/, '');
const PASSWORD = args['password'] || 'Password123!';

// ---------- 결과 수집용 ----------
const metrics = {
    register: { ok: 0, fail: 0, latencies: [] },
    login:    { ok: 0, fail: 0, latencies: [] },
    rooms:    { ok: 0, fail: 0, latencies: [] },
    delete:   { ok: 0, fail: 0, latencies: [] },
    errors: {},
};
let activeUsers = 0;         // 현재 진행 중인 유저 수
let totalRequestsWindow = 0; // 최근 1초간 완료된 요청 수 (실시간 RPS 계산용)

function recordError(msg) { metrics.errors[msg] = (metrics.errors[msg] || 0) + 1; }
function countReq() { totalRequestsWindow++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 한 명의 유저 시나리오 ----------
async function runUser(index) {
    activeUsers++;
    const unique = `${Date.now()}_${index}_${Math.floor(Math.random() * 1e6)}`;
    const email = `loadtest_${unique}@test.com`;
    const name = `tester_${unique}`;
    let token = null;

    try {
        // 1) 회원가입
        {
            const start = Date.now();
            try {
                const res = await axios.post(`${API_URL}/api/auth/register`,
                    { name, email, password: PASSWORD },
                    { timeout: 10000, validateStatus: () => true });
                metrics.register.latencies.push(Date.now() - start); countReq();
                if (res.status === 200 || res.status === 201) metrics.register.ok++;
                else { metrics.register.fail++; recordError(`register: ${res.status} ${res.data && res.data.message ? res.data.message : ''}`.trim()); return; }
            } catch (e) { metrics.register.latencies.push(Date.now() - start); countReq(); metrics.register.fail++; recordError(`register: ${e.code || e.message}`); return; }
        }

        // 2) 로그인
        {
            const start = Date.now();
            try {
                const res = await axios.post(`${API_URL}/api/auth/login`,
                    { email, password: PASSWORD },
                    { timeout: 10000, validateStatus: () => true });
                metrics.login.latencies.push(Date.now() - start); countReq();
                token = res.data && res.data.token;
                if ((res.status === 200 || res.status === 201) && token) metrics.login.ok++;
                else { metrics.login.fail++; recordError(`login: ${res.status} ${!token ? 'token 없음' : (res.data && res.data.message) || ''}`.trim()); return; }
            } catch (e) { metrics.login.latencies.push(Date.now() - start); countReq(); metrics.login.fail++; recordError(`login: ${e.code || e.message}`); return; }
        }

        // 3) 목록조회 반복
        for (let i = 0; i < LOOPS; i++) {
            const start = Date.now();
            try {
                await axios.get(`${API_URL}/api/rooms`,
                    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
                metrics.rooms.latencies.push(Date.now() - start); countReq(); metrics.rooms.ok++;
            } catch (e) { metrics.rooms.latencies.push(Date.now() - start); countReq(); metrics.rooms.fail++; recordError(`rooms: ${e.response ? e.response.status : e.code || e.message}`); }
            if (THINK > 0) await sleep(THINK);
        }

        // 4) 탈퇴
        {
            const start = Date.now();
            try {
                await axios.delete(`${API_URL}/api/users/account`,
                    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
                metrics.delete.latencies.push(Date.now() - start); countReq(); metrics.delete.ok++;
            } catch (e) { metrics.delete.latencies.push(Date.now() - start); countReq(); metrics.delete.fail++; recordError(`delete: ${e.response ? e.response.status : e.code || e.message}`); }
        }
    } finally {
        activeUsers--;
    }
}

// ---------- 통계 ----------
function stats(latencies) {
    if (latencies.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    return { avg: avg.toFixed(1), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: sorted[sorted.length - 1] };
}

function printReport(elapsedMs) {
    const line = '─'.repeat(60);
    console.log('\n' + line);
    console.log(`부하 테스트 결과  (초당 투입 ${ARRIVAL}명 · 조회 ${LOOPS}회 · think ${THINK}ms · 지속 ${DURATION}초)`);
    console.log(`총 소요 시간: ${(elapsedMs / 1000).toFixed(1)}초`);
    console.log(line);
    const rows = [
        ['회원가입 (register)', metrics.register],
        ['로그인 (login)', metrics.login],
        ['목록조회 (rooms)', metrics.rooms],
        ['회원탈퇴 (delete)', metrics.delete],
    ];
    let totalReq = 0;
    for (const [label, m] of rows) {
        const s = stats(m.latencies);
        const total = m.ok + m.fail;
        totalReq += total;
        const rate = total ? ((m.ok / total) * 100).toFixed(1) : '0.0';
        console.log(`\n[${label}]`);
        console.log(`  성공/전체 : ${m.ok}/${total}  (성공률 ${rate}%)`);
        console.log(`  응답시간  : avg ${s.avg}ms · p50 ${s.p50}ms · p95 ${s.p95}ms · p99 ${s.p99}ms · max ${s.max}ms`);
    }
    console.log(`\n총 요청 수: ${totalReq}  ·  평균 RPS: ${(totalReq / (elapsedMs / 1000)).toFixed(1)}`);
    const errKeys = Object.keys(metrics.errors);
    console.log('\n' + line);
    if (errKeys.length === 0) console.log('에러 없음');
    else { console.log('에러 내역:'); for (const k of errKeys) console.log(`  ${k} : ${metrics.errors[k]}회`); }
    console.log(line + '\n');
}

// ---------- 실행 ----------
(async () => {
    console.log(`\n지속 부하 시작: 초당 ${ARRIVAL}명씩 ${DURATION}초간 투입`);
    console.log(`대상: ${API_URL}\n`);
    const start = Date.now();
    const running = [];
    let userIndex = 0;

    // 실시간 RPS/활성유저 출력 (1초마다)
    const monitor = setInterval(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`[${elapsed}s] 실시간 RPS: ${totalRequestsWindow}  ·  활성 유저: ${activeUsers}`);
        totalRequestsWindow = 0;
    }, 1000);

    // DURATION초 동안 매초 ARRIVAL명씩 투입
    for (let sec = 0; sec < DURATION; sec++) {
        for (let i = 0; i < ARRIVAL; i++) {
            running.push(runUser(userIndex++));
        }
        await sleep(1000);
    }

    // 투입 종료 후, 진행 중인 유저들이 끝날 때까지 대기
    console.log('\n투입 종료. 진행 중인 유저 완료 대기...');
    await Promise.all(running);
    clearInterval(monitor);

    printReport(Date.now() - start);
})();