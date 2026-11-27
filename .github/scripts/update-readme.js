const fs = require('fs');

module.exports = async ({ github, context }) => {
  const tick = String.fromCharCode(96);
  const username = context.repo.owner;
  const profileRepo = (username + '/' + username).toLowerCase();

  // 1. GraphQL로 개인 Projects V2 상태 조회 (read:org 없이 project + repo 권한만으로 작동)
  const graphqlQuery = [
    'query {',
    '  viewer {',
    '    projectsV2(first: 10) {',
    '      nodes {',
    '        items(first: 100) {',
    '          nodes {',
    '            fieldValues(first: 20) {',
    '              nodes {',
    '                ... on ProjectV2ItemFieldSingleSelectValue { name }',
    '                ... on ProjectV2ItemFieldTextValue { text }',
    '              }',
    '            }',
    '            content {',
    '              ... on Issue {',
    '                title url state',
    '                repository { name nameWithOwner }',
    '              }',
    '              ... on DraftIssue { title }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  const statusMap = new Map();
  const draftTodos = [];

  try {
    const gqlRes = await github.graphql(graphqlQuery);
    const allProjects = gqlRes.viewer?.projectsV2?.nodes || [];

    allProjects.forEach(proj => {
      (proj.items?.nodes || []).forEach(item => {
        const content = item.content;
        if (!content || !content.title) return;

        let mappedStatus = '';
        const fields = item.fieldValues?.nodes || [];
        for (const f of fields) {
          const val = (f?.name || f?.text || '').toLowerCase().trim();
          if (!val) continue;
          if (val.includes('review') || val.includes('done') || val.includes('완료')) {
            mappedStatus = 'excluded';
            break;
          }
          if (val.includes('in progress') || val.includes('inprogress') || val.includes('진행')) {
            mappedStatus = 'in progress';
            break;
          }
          if (val.includes('todo') || val.includes('to do') || val.includes('할 일')) {
            mappedStatus = 'todo';
            break;
          }
          if (val.includes('backlog') || val.includes('백로그')) {
            mappedStatus = 'backlog';
            break;
          }
        }

        if (content.url) {
          if (mappedStatus) statusMap.set(content.url, mappedStatus);
        } else if (mappedStatus && mappedStatus !== 'excluded') {
          draftTodos.push({
            title: content.title,
            url: '',
            repoName: 'Project',
            status: mappedStatus
          });
        }
      });
    });
  } catch (e) {
    console.log('GraphQL 조회 에러:', e.message);
  }

  // 2. 일반 저장소 Open 이슈 검색 후 Projects 상태 결합
  const { data: searchRes } = await github.rest.search.issuesAndPullRequests({
    q: 'author:' + username + ' is:issue is:open',
    sort: 'updated',
    order: 'desc',
    per_page: 50
  });

  const combinedTodos = [...draftTodos];

  for (const issue of searchRes.items) {
    const repoFullName = issue.repository_url.split('/repos/').pop().toLowerCase();
    if (repoFullName === profileRepo) continue;

    const labelNames = issue.labels.map(l => l.name.toLowerCase().trim());
    if (labelNames.includes('review') || labelNames.includes('done')) continue;

    let status = statusMap.get(issue.html_url) || '';
    if (!status) {
      if (labelNames.some(n => n.includes('in progress') || n.includes('inprogress'))) status = 'in progress';
      else if (labelNames.some(n => n.includes('todo') || n.includes('to do'))) status = 'todo';
      else if (labelNames.some(n => n.includes('backlog'))) status = 'backlog';
    }

    if (status === 'excluded') continue;

    combinedTodos.push({
      title: issue.title,
      url: issue.html_url,
      repoName: issue.repository_url.split('/').pop(),
      status
    });
  }

  const getPriority = (status) => {
    if (status === 'in progress') return 1;
    if (status === 'todo') return 2;
    if (status === 'backlog') return 3;
    return 4;
  };

  let todoList = '';
  if (combinedTodos.length === 0) {
    todoList = '- No open tasks 🎉';
  } else {
    const sorted = combinedTodos.sort((a, b) => getPriority(a.status) - getPriority(b.status));
    todoList = sorted.map(task => {
      let badge = '📌';
      if (task.status === 'in progress') badge = '🚧';
      else if (task.status === 'todo') badge = '📝';
      else if (task.status === 'backlog') badge = '📦';

      const linkText = task.url ? '[' + task.title + '](' + task.url + ')' : task.title;
      return '- ' + badge + ' **[' + task.repoName + ']** ' + linkText;
    }).join('\n');
  }

  // 3. 프로필 저장소 논문 목록 & 키워드 집계
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

  // 4. README.md 업데이트
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
