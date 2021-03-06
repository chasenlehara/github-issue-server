const express = require('express');
const fs = require('fs');
const https = require('https');
const ngrok = require('ngrok');

/* Read the command’s arguments */
const authorizationToken = process.argv[2];// Required
const port = process.argv[3] || 8080;// Optional
if (!authorizationToken) {
  throw new Error('No authorization token provided; please include it as the first argument to this script.');
}

/* Set up our issues file “database” */
const issuesFilePath = 'issues.json';
const issuesDB = (fs.existsSync(issuesFilePath)) ? JSON.parse(fs.readFileSync(issuesFilePath, {encoding: 'utf8'})) : {};

/* Static server */
const app = express();
app.use(express.static(process.cwd()));

/* Socket.io */
const httpServer = require('http').Server(app);
const io = require('socket.io')(httpServer);

/* GitHub API server */
const requestPath = '/api/github/repos/:org/:repo/issues';
app.get(requestPath, function(req, res) {
  const options = getRequestOptions(req);
  const callback = function(dataStream) {
    getContentFromStream(dataStream, function(body) {
      const issues = updateIssuesWithSortPositions(JSON.parse(body));
      res.send(JSON.stringify(issues));
    });
  };
  https.request(options, callback).end();
});

app.post(requestPath, function(req, res) {
  let sortPosition;
  const options = getRequestOptions(req, 'POST');
  const callback = function(dataStream) {
    getContentFromStream(dataStream, function(body) {
      const issue = JSON.parse(body);
      setSortPositionForIssueWithID(sortPosition, issue.id);
      saveIssuesDB();
      res.send(JSON.stringify(issue));
    });
  };
  const postRequest = https.request(options, callback);

  // Read the request to get the JSON body that should be POSTed
  getContentFromStream(req, function(body) {
    const issue = JSON.parse(body);
    sortPosition = issue.sort_position;
    postRequest.write(body);
    postRequest.end();
  });
});

app.put(`${requestPath}/:id`, function(req, res) {
  getContentFromStream(req, function(body) {
    const issue = Object.assign(JSON.parse(body), {id: req.params.id});
    setSortPositionForIssueWithID(issue.sort_position, issue.id);
    saveIssuesDB();
    res.send(body);
    io.emit('issue updated', issue);
  });
});

/* Webhook handler */
app.post('/api/webhook', function(request, response) {
  getContentFromStream(request, function(body) {
    try {
      const payload = JSON.parse(body);
      const issue = payload.issue;
      console.info(`Received “${payload.action}” action from GitHub for issue “${issue.title}”`);
      if (payload.action === 'closed') {
        removeSortPositionForIssueWithID(issue.id);
        io.emit('issue removed', issue);
      } else if (payload.action === 'edited') {
        io.emit('issue updated', issue);
      } else if (payload.action === 'opened' || payload.action === 'reopened') {
        updateIssueWithFirstSortPosition(issue);
        io.emit('issue created', issue);
      }
    } catch (error) {
      console.error(error);
    }
  });
  response.end();
});

/* Start the server */
httpServer.listen(port, function() {
  console.info(`Started up server, available at:
    http://localhost:${port}/`);
});

/* Set up ngrok */
ngrok.connect(port, function(error, url) {
  if (error) {
    console.error('Failed to connect ngrok with error:', error);
  } else {
    console.info(`Started up ngrok server; GitHub Webhook Payload URL:
    ${url}/api/webhook`);
  }
});

function getContentFromStream(request, callback) {
  var body = '';
  request.on('data', function(chunk) {
    body += chunk;
  });
  request.on('end', function() {
    callback(body);
  });
}

function getRequestOptions(req, method) {
  return {
    headers: {
      Authorization: 'token ' + authorizationToken,
      'User-Agent': req.headers['user-agent']
    },
    host: 'api.github.com',
    method: method || 'GET',
    path: `/repos/${req.params.org}/${req.params.repo}/issues`
  };
}

function getSortPositionForIssueWithID(id) {
  return issuesDB[id];
}

function removeSortPositionForIssueWithID(id) {
  if (issuesDB[id]) {
    delete issuesDB[id];
    saveIssuesDB();
  }
}

function saveIssuesDB() {
  fs.writeFile(issuesFilePath, JSON.stringify(issuesDB), function(error) {
    if (error) {
      console.error('Failed to save issues file with error:', error);
    } else {
      console.info(`Successfully saved ${issuesFilePath}`);
    }
  });
}

function updateIssuesWithSortPositions(issues) {
  let {max, min} = maxAndMinInIssuesDB();
  let needToSave = false;
  for (var i = 0; i < issues.length; i++) {
    const issue = issues[i];
    issue.sort_position = getSortPositionForIssueWithID(issue.id);
    if (issue.sort_position === undefined) {
      issue.sort_position = (min = (max + min) / 2);
      setSortPositionForIssueWithID(issue.sort_position, issue.id);
      needToSave = true;
    }
  }
  if (needToSave) {
    saveIssuesDB();
  }
  issues.sort(function(a, b) {
    return a.sort_position - b.sort_position;
  });
  return issues;
}

function maxAndMinInIssuesDB() {
  const values = [];
  for (let id in issuesDB) {
    values.push(issuesDB[id]);
  }
  const max = Math.max.apply(null, values);
  const min = Math.min.apply(null, values);
  return {
    max: (max === -Infinity) ? Math.ceil(Number.MAX_SAFE_INTEGER / 2) : max,
    min: (min === Infinity) ? Math.floor(Number.MIN_SAFE_INTEGER / 2) : min
  };
}

function setSortPositionForIssueWithID(sortPosition, id) {
  issuesDB[id] = sortPosition;
}

function updateIssueWithFirstSortPosition(issue) {
  const {min} = maxAndMinInIssuesDB();
  issue.sort_position = getSortPositionForIssueWithID(issue.id);
  if (issue.sort_position === undefined) {
    issue.sort_position = (Number.MIN_SAFE_INTEGER + min) / 2;
    setSortPositionForIssueWithID(issue.sort_position, issue.id);
    saveIssuesDB();
  }
  return issue;
}
