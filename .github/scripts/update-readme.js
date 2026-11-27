const fs = require('fs');

module.exports = async ({ github, context }) => {
  const tick = String.fromCharCode(96);
  const username = context.repo.owner;
  const profileRepo = (username + '/' + username).toLowerCase();

  // 1. 내 계정이 접근 가능한 모든 저장소 목록 가져오기
  const { data: repos } = await github.rest.repos.listForAuthenticatedUser({
    per_page: 100,
    sort: 'updated'
  });

  // 알려주신 GraphQL 쿼리: 저장소별 OPEN 이슈와 연결된 Projects의 Status 조회
  const repoIssuesQuery = [
    'query($owner: String!, $repo: String!) {',
    '  repository(owner: $owner, name: $repo) {',
    '    issues(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {',
    '      nodes {',
    '        title',
    '        url',
    '        labels(first: 10) { nodes { name } }',
    '        projectItems(first: 5) {',
    '          nodes {',
    '            fieldValueByName(name: "Status") {',
    '              ... on ProjectV2ItemFieldSingleSelectValue { name }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  const allTodos = [];

  for (const repo of repos) {
    if (repo.full_name.toLowerCase() === profileRepo) continue;

    try {
      const res = await github.graphql(repoIssuesQuery, {
        owner: repo.owner.login,
        repo: repo.name
      });

      const issues = res.repository?.issues?.nodes || [];
      for (const issue of issues) {
        const labelNames = (issue.labels?.nodes || []).map(l => l.name.toLowerCase().trim());
        if (labelNames.includes('review') || labelNames.includes('done')) continue;

        const projectItem = issue.projectItems?.nodes?.at(0);
        const rawStatus = (projectItem?.fieldValueByName?.name || '').toLowerCase().trim();

        let status = '';
        if (rawStatus.includes('review') || rawStatus.includes('done')) continue;
        else if (rawStatus.includes('in progress') || rawStatus.includes('inprogress')) status = 'in progress';
        else if (rawStatus.includes('todo') || rawStatus.includes('to do')) status = 'todo';
        else if (rawStatus.includes('backlog')) status = 'backlog';

        // Projects Status가 없으면 라벨에서 보조 확인
        if (!status) {
          if (labelNames.some(n => n.includes('in progress') || n.includes('inprogress'))) status = 'in progress';
          else if (labelNames.some(n => n.includes('todo') || n.includes('to do'))) status = 'todo';
          else if (labelNames.some(n => n.includes('backlog'))) status = 'backlog';
        }

        allTodos.push({
          title: issue.title,
          url: issue.url,
          repoName: repo.name,
          status
        });
      }
    } catch (e) {
      // 이슈가 비활성화된 저장소 등은 건너뜀
    }
  }

  const getPriority = (status) => {
    if (status === 'in progress') return 1;
    if (status === 'todo') return 2;
    if (status === 'backlog') return 3;
    return 4;
  };

  let todoList = '';
  if (allTodos.length === 0) {
    todoList = '- No open tasks 🎉';
  } else {
    const sorted = allTodos.sort((a, b) => getPriority(a.status) - getPriority(b.status));
    todoList = sorted.map(task => {
      let badge = '📌';
      if (task.status === 'in progress') badge = '🚧';
      else if (task.status === 'todo') badge = '📝';
      else if (task.status === 'backlog') badge = '📦';

      return '- ' + badge + ' **[' + task.repoName + ']** [' + task.title + '](' + task.url + ')';
    }).join('\n');
  }

  // 2. 프로필 저장소(birdf00t/birdf00t) 논문 목록 & 키워드 집계
  const { data: paperIssues } = await github.rest.issues.listForRepo({
    owner: username,
    repo: username,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 100
  });

  const activePapers = paperIssues.filter(issue => {
    if (issue.pull_request) return false;
    const names = issue.labels.map(l => l.name.toLowerCase().trim());
    return !names.includes('backlog');
  });

  const keywordCounts = {};
  activePapers.forEach(issue => {
    if (!issue.body) return;
    const match = issue.body.match(/\*\*Keywords\*\*\s*:\s*(.+)/i);
    const rawKeywords = match ? match.at(1) : null;
    if (rawKeywords) {
      rawKeywords.split(',').forEach(raw => {
        const kw = raw.trim();
        if (kw) {
          const key = kw.toLowerCase();
          if (!keywordCounts[key]) keywordCounts[key] = { label: kw, count: 0 };
          keywordCounts[key].count += 1;
        }
      });
    }
  });

  const topKeywords = Object.values(keywordCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(item => tick + item.label + tick);

  const keywordLine = topKeywords.length > 0
    ? '- 🏷️ ' + topKeywords.join(', ')
    : '- 🏷️ No keywords yet';

  const isPaperDone = (issue) => {
    const names = issue.labels.map(l => l.name.toLowerCase().trim());
    return issue.state === 'closed' || names.includes('done');
  };

  const doneCount = activePapers.filter(isPaperDone).length;

  let paperList = '';
  if (activePapers.length === 0) {
    paperList = '- No papers logged yet 📚';
  } else {
    const sortedPapers = activePapers.sort((a, b) => {
      const aDone = isPaperDone(a);
      const bDone = isPaperDone(b);
      if (aDone === bDone) return 0;
      return aDone ? 1 : -1;
    });

    const unit = doneCount === 1 ? 'paper' : 'papers';
    const summaryLine = tick + 'Total Completed: ' + doneCount + ' ' + unit + tick + '\n';
    const itemsText = sortedPapers.slice(0, 15).map(issue => {
      const done = isPaperDone(issue);
      const badge = done ? '✅' : '📖';
      return '- ' + badge + ' [' + issue.title + '](' + issue.html_url + ')';
    }).join('\n');

    paperList = summaryLine + '\n' + itemsText;
  }

  // 3. README.md 업데이트
  let readme = fs.readFileSync('README.md', 'utf8');
  readme = readme.replace(
    /<!-- START_KEYWORDS -->[\s\S]*<!-- END_KEYWORDS -->/,
    '<!-- START_KEYWORDS -->\n' + keywordLine + '\n<!-- END_KEYWORDS -->'
  );
  readme = readme.replace(
    /<!-- START_TODO_ISSUES -->[\s\S]*<!-- END_TODO_ISSUES -->/,
    '<!-- START_TODO_ISSUES -->\n' + todoList + '\n<!-- END_TODO_ISSUES -->'
  );
  readme = readme.replace(
    /<!-- START_PAPERS -->[\s\S]*<!-- END_PAPERS -->/,
    '<!-- START_PAPERS -->\n' + paperList + '\n<!-- END_PAPERS -->'
  );

  fs.writeFileSync('README.md', readme);
};
