var fs = require('fs');
var path = require('path');

var LEARNING_DATA_PATH = '$env:USERPROFILE\\glm4_finetune\\learning_data\\learning_log.jsonl';
var LEARNING_SUMMARY_PATH = '$env:USERPROFILE\\glm4_finetune\\learning_data\\learning_summary.jsonl';
var SUMMARY_CACHE_PATH = '$env:USERPROFILE\\glm4_finetune\\learning_data\\last_summary_index.txt';

function generateLearningSummary() {
  try {
    if (!fs.existsSync(LEARNING_DATA_PATH)) return {success:false,reason:'no_data'};
    var raw = fs.readFileSync(LEARNING_DATA_PATH, 'utf8');
    var lines = raw.split('\n').filter(function(l){return l.trim();});
    if (lines.length < 3) return {success:false,reason:'insufficient_data'};
    var lastIndex = 0;
    try { if (fs.existsSync(SUMMARY_CACHE_PATH)) lastIndex = parseInt(fs.readFileSync(SUMMARY_CACHE_PATH,'utf8').trim())||0; } catch(e){}
    var newEntries = lines.slice(lastIndex);
    if (newEntries.length === 0) return {success:true,reason:'up_to_date',processed:0};
    var records = [];
    newEntries.forEach(function(line){try{records.push(JSON.parse(line));}catch(e){}});
    if (records.length === 0) return {success:false,reason:'parse_error'};
    var patterns = [];
    var qt = {};
    records.forEach(function(r){
      var q=(r.question||'').toLowerCase();
      if(q.indexOf('\u4f60\u597d')>=0||q.indexOf('hello')>=0) qt['\u6253\u62db\u547c']=(qt['\u6253\u62db\u547c']||0)+1;
      else if(q.indexOf('\u6267\u884c')>=0) qt['\u547d\u4ee4\u6267\u884c']=(qt['\u547d\u4ee4\u6267\u884c']||0)+1;
      else if(q.indexOf('\u5929\u6c14')>=0) qt['\u5929\u6c14\u67e5\u8be2']=(qt['\u5929\u6c14\u67e5\u8be2']||0)+1;
      else qt['\u5176\u4ed6']=(qt['\u5176\u4ed6']||0)+1;
    });
    patterns.push({type:'question_dist',data:qt});
    var summary = {timestamp:new Date().toISOString(),totalRecords:records.length,patterns:patterns,recommendations:['\u5df2\u5206\u6790'+records.length+'\u6761\u6570\u636e']};
    try {
      var d=path.dirname(LEARNING_SUMMARY_PATH);
      if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});
      fs.appendFileSync(LEARNING_SUMMARY_PATH,JSON.stringify(summary)+'\n','utf8');
      fs.writeFileSync(SUMMARY_CACHE_PATH,String(lastIndex+newEntries.length));
    } catch(e){}
    return {success:true,processed:records.length,patterns:1};
  } catch(error) { return {success:false,error:error.message}; }
}

module.exports = { generateLearningSummary: generateLearningSummary };