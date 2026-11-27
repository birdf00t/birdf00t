const fs = require('fs');

module.exports = async ({ github, context }) => {
  const tick = String.fromCharCode(96);
  const username = context.repo.owner;
  const profileRepo = (username + '/' + username).toLowerCase();

  // 1. 접근 가능한 모든 저장소에서 보내주신 GraphQL 쿼리 그대로 실행
  const { data: repos } = await github.rest.repos.listForAuthenticatedUser({
    per_page: 100,
    sort: 'updated'
  });

  const query = [
    'query($owner: String!, $repo: String!) {',
    '  repository(owner: $owner, name: $repo) {',
    '    issues(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {',
    '      nodes {',
    '        number',
    '        title',
    '        state',
    '        url',
    '        projectItems(first: 5) {',
    '          nodes {',
    '            project {',
    '              title',
    '            }',
    '            fieldValueByName(name: "Status") {',
    '              ... on ProjectV2ItemFieldSingleSelectValue {',
    '                name',
    '              }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  let allIssues = [];

  for (const repo of repos) {
    if (repo.full_name.toLowerCase() === profileRepo) continue;

    try {
      const result = await github.graphql(query, {
        owner: repo.owner.login,
        repo: repo.name
      });

      const nodes = result.repository?.issues?.nodes || [];
      const formatted = nodes.map((issue) => {
        const projectItem = issue.projectItems?.nodes?.at(0);
        const status = projectItem?.fieldValueByName?.name || '상태 없음';

        return {
          repo: repo.name,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          status: status,
          url: issue.url
        };
      });

      allIssues = allIssues.concat(formatted);
    } catch (e) {
      // 이슈 조회 불가 저장소 건너뜀
    }
  }

  // API에서 가져온 값 그대로 README.md에 프린트
  let todoList = '';
  if (allIssues.length === 0) {
    todoList = '- 가져온 이슈가 없습니다.';
  } else {
    todoList = allIssues.map(item => {
      return '- **[' + item.repo + ' #' + item.number + ']** [' + item.title + '](' + item.url + ') | state: `' + item.state + '` | status: `' + item.status + '`';
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
