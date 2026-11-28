const fs = require('fs');

module.exports = async ({ github, context }) => {
  const tick = String.fromCharCode(96);
  const username = context.repo.owner;
  const profileRepo = (username + '/' + username).toLowerCase();

  // 1. 내 공개 레포의 열린(Open) 이슈 가져오기 (앞 이모티콘 제거)
  const { data: searchRes } = await github.rest.search.issuesAndPullRequests({
    q: 'user:' + username + ' is:issue is:open is:public',
    sort: 'updated',
    order: 'desc',
    per_page: 50
  });

  const todos = searchRes.items
    .filter(issue => {
      const repoFullName = issue.repository_url.split('/repos/').pop().toLowerCase();
      return repoFullName !== profileRepo;
    })
    .map(issue => ({
      repoName: issue.repository_url.split('/').pop(),
      title: issue.title,
      url: issue.html_url
    }));

  let todoList = '';
  if (todos.length === 0) {
    todoList = '- No open tasks 🎉';
  } else {
    todoList = todos.map(t => {
      return '- **[' + t.repoName + ']** [' + t.title + '](' + t.url + ')';
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

  const activePapers = paperIssues.filter(issue => !issue.pull_request);

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

  const isPaperDone = (issue) => issue.state === 'closed';
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
      const badge = done ? '' : '📖';
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
