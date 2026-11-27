const fs = require('fs');

module.exports = async ({ github, context }) => {
  const tick = String.fromCharCode(96);
  const username = context.repo.owner;

  const graphqlQuery = [
    'query {',
    '  viewer {',
    '    login',
    '    projectsV2(first: 10) {',
    '      nodes {',
    '        title',
    '        items(first: 50) {',
    '          nodes {',
    '            fieldValues(first: 20) {',
    '              nodes {',
    '                ... on ProjectV2ItemFieldSingleSelectValue { name }',
    '                ... on ProjectV2ItemFieldTextValue { text }',
    '              }',
    '            }',
    '            content {',
    '              ... on Issue { title url state }',
    '              ... on DraftIssue { title }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '    organizations(first: 10) {',
    '      nodes {',
    '        login',
    '        projectsV2(first: 10) {',
    '          nodes {',
    '            title',
    '            items(first: 50) {',
    '              nodes {',
    '                fieldValues(first: 20) {',
    '                  nodes {',
    '                    ... on ProjectV2ItemFieldSingleSelectValue { name }',
    '                    ... on ProjectV2ItemFieldTextValue { text }',
    '                  }',
    '                }',
    '                content {',
    '                  ... on Issue { title url state }',
    '                  ... on DraftIssue { title }',
    '                }',
    '              }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');

  let rawGraphQLOutput = '';
  try {
    const gqlRes = await github.graphql(graphqlQuery);
    rawGraphQLOutput = JSON.stringify(gqlRes, null, 2);
  } catch (e) {
    rawGraphQLOutput = 'GraphQL Error: ' + e.message;
  }

  const todoList = tick + tick + tick + 'json\n' + rawGraphQLOutput + '\n' + tick + tick + tick;

  // 프로필 저장소 논문 목록 & 키워드 유지
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
