#!/usr/bin/env node

// Load environment variables
require('dotenv').config({
    path: __dirname + '/.env'
});

// Import various nodejs modules
const fs=require('fs');
const express=require('express');
const request=require('request');
const async = require('async');
const WebSocket = require('ws');
const findPort = require('find-port');
const keypair = require('keypair');
const sha1=require('node-sha1');
const watcher = require('chokidar');

const KBUCKET_HUB_URL=process.env.KBUCKET_HUB_URL||'https://kbucket.flatironinstitute.org';
const KBUCKET_SHARE_PROTOCOL='http'; //todo: support https
const KBUCKET_SHARE_HOST=process.env.KBUCKET_SHARE_HOST||'localhost';
const KBUCKET_SHARE_PORT_RANGE=process.env.KBUCKET_SHARE_PORT||process.env.KBUCKET_SHARE_PORT_RANGE||'12000-13000';
var KBUCKET_SHARE_PORT=undefined; //determined below

var CLP=new CLParams(process.argv);

var share_directory=CLP.unnamedParameters[0]||'.';
share_directory=require('path').resolve(share_directory);
if (!fs.existsSync(share_directory)) {
  console.error('Directory does not exist: '+share_directory);
  process.exit(-1);
}
if (!fs.statSync(share_directory).isDirectory()) {
  console.error('Not a directory: '+share_directory);
  process.exit(-1);
}

// Set environment variable DEBUG=true to get some debugging console output
const debugging=(process.env.DEBUG=='true');

console.log (`
Using the following:
  KBUCKET_HUB_URL=${KBUCKET_HUB_URL}
  KBUCKET_SHARE_PROTOCOL=${KBUCKET_SHARE_PROTOCOL}
  KBUCKET_SHARE_HOST=${KBUCKET_SHARE_HOST}
  KBUCKET_SHARE_PORT_RANGE=${KBUCKET_SHARE_PORT_RANGE}
  debugging=${debugging}

Sharing directory: ${share_directory}

`);

var KBSC=new KBShareConfig(share_directory);
KBSC.initialize(function() {
  console.log (`Share key: ${KBSC.kbShareId()}`);
  setTimeout(function() {
    start_server();
  },100);
});


// ===================================================== //

const app = express();
app.set('json spaces', 4); // when we respond with json, this is how it will be formatted

// API readdir
app.get('/:kbshare_id/api/readdir/:subdirectory(*)',function(req,res) {
  if (!check_kbshare_id(req,res)) return;
  var params=req.params;
  handle_readdir(params.subdirectory,req,res);
});
app.get('/:kbshare_id/api/readdir/',function(req,res) {
  if (!check_kbshare_id(req,res)) return;
  var params=req.params;
  handle_readdir('',req,res);
});

// API download
app.get('/:kbshare_id/download/:filename(*)',function(req,res) {
  if (!check_kbshare_id(req,res)) return;
  var params=req.params;
  handle_download(params.filename,req,res);
});

// API web
// don't really need to check the share key here because we won't be able to get anything except in the web/ directory
app.use('/:kbshare_id/web', express.static(__dirname+'/web'));

// ===================================================== //


function check_kbshare_id(req,res) {
  var params=req.params;
  if (params.kbshare_id!=KBSC.kbShareId()) {
    var errstr=`Incorrect kbucket share key: ${params.kbshare_id}`;
    console.error(errstr);
    res.status(500).send({error:errstr});
    return false;
  }
  return true;
}

function handle_readdir(subdirectory,req,res) {
  allow_cross_domain_requests(req,res);
  if (!is_safe_path(subdirectory)) {
    res.status(500).send({error:'Unsafe path: '+subdirectory});
    return;
  }
  var path0=require('path').join(share_directory,subdirectory);
  fs.readdir(path0,function(err,list) {
    if (err) {
      res.status(500).send({error:err.message});
      return;
    }
    var files=[],dirs=[];
    async.eachSeries(list,function(item,cb) {
      if ((item=='.')||(item=='..')||(item=='.kbucket')) {
        cb();
        return;
      }
      fs.stat(require('path').join(path0,item),function(err0,stat0) {
        if (err0) {
          res.status(500).send({error:`Error in stat of file ${item}: ${err0.message}`});
          return;
        }
        if (stat0.isFile()) {
          files.push({
            name:item,
            size:stat0.size
          });
        }
        else if (stat0.isDirectory()) {
          if (!is_excluded_directory_name(item)) {
            dirs.push({
              name:item
            });
          }
        }
        cb();
      });
    },function() {
      res.json({success:true,files:files,dirs:dirs}); 
    });
  });
}

function handle_download(filename,req,res) {
  allow_cross_domain_requests(req,res);

  // don't worry too much because express takes care of this below (b/c we specify a root directory)
  if (!is_safe_path(filename)) {
    res.status(500).send({error:'Unsafe path: '+filename});
    return;
  }
  var path0=require('path').join(share_directory,filename);
  if (!fs.existsSync(path0)) {
    res.status(404).send('404: File Not Found');
    return;
  }
  if (!fs.statSync(path0).isFile()) {
    res.status(500).send({error:'Not a file: '+filename});
    return;
  }
  res.sendFile(filename,{dotfiles:'allow',root:share_directory});
}

function is_safe_path(path) {
  var list=path.split('/');
  for (var i in list) {
    var str=list[i];
    if ((str=='~')||(str=='.')||(str=='..')) return false;
  }
  return true;
}

function start_server(callback) {
  get_free_port_in_range(KBUCKET_SHARE_PORT_RANGE.split('-'),function(err,port) {
    KBUCKET_SHARE_PORT=port;
    app.listen(KBUCKET_SHARE_PORT, function() {
      console.log (`Listening on port ${KBUCKET_SHARE_PORT}`);
      console.log (`Web interface: ${KBUCKET_SHARE_PROTOCOL}://${KBUCKET_SHARE_HOST}:${KBUCKET_SHARE_PORT}/${KBSC.kbShareId()}/web`)
      connect_to_websocket();
    });
  });
}

function get_free_port_in_range(range,callback) {
  var findPort = require('find-port');
  if (range.length>2) {
    callback('Invalid port range.');
    return;
  }
  if (range.length<1) {
    callback('Invalid port range (*).');
    return;
  }
  if (range.length==1) {
    range.push(range[0]);
  }
  range[0]=Number(range[0]);
  range[1]=Number(range[1]);
  findPort('127.0.0.1', range[0], range[1], function(ports) {
      if (ports.length==0) {
        callback(`No free ports found in range ${range[0]}-${range[1]}`);
        return;
      }
      callback(null,ports[0]);
  });
}

function allow_cross_domain_requests(req,res) {
  if (req.method == 'OPTIONS') {
      res.set('Access-Control-Allow-Origin', '*');
      res.set("Access-Control-Allow-Methods", "POST, GET, HEAD, OPTIONS");
      res.set("Access-Control-Allow-Credentials", true);
      res.set("Access-Control-Max-Age", '86400'); // 24 hours
      res.set("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, Authorization, Range");
      res.status(200).send();
        return;
    }
    else {
      res.header("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept, Authorization, Range");  
    }
}

var HTTP_REQUESTS={};

function HttpRequest(on_message_handler) {
  this.initiateRequest=function(msg) {initiateRequest(msg);};
  this.writeRequestData=function(data) {writeRequestData(data);};
  this.endRequest=function() {endRequest();};

  var m_request=null;

  function initiateRequest(msg) {
    /*
    var opts={
      method:msg.method,
      hostname:'localhost',
      port:KBUCKET_SHARE_PORT,
      path:msg.path,
      headers:msg.headers
    };
    */
    var opts={
      method:msg.method,
      uri:`http://localhost:${KBUCKET_SHARE_PORT}/${msg.path}`,
      headers:msg.headers,
      followRedirect:false // important because we want the proxy server to handle it instead
    }
    m_request=request(opts);
    m_request.on('response',function(resp) {
      on_message_handler({command:'http_set_response_headers',status:resp.statusCode,status_message:resp.statusMessage,headers:resp.headers});
      resp.on('error',on_response_error);
      resp.on('data',on_response_data);
      resp.on('end',on_response_end);
    });
    m_request.on('error',function(err) {
      on_message_handler({command:'http_report_error',error:'Error in request: '+err.message});
    });
  }

  function writeRequestData(data) {
    if (!m_request) {
      console.error('Unexpected: m_request is null in writeRequestData.');
      return;
    }
    m_request.write(data);
  }

  function endRequest() {
    if (!m_request) {
      console.error('Unexpected: m_request is null in endRequest.');
      return;
    }
    m_request.end();
  }

  function on_response_data(data) {
    on_message_handler({
      command:'http_write_response_data',
      data_base64:data.toString('base64')
    });
  }

  function on_response_end() {
    on_message_handler({
      command:'http_end_response'
    });
  }

  function on_response_error(err) {
    on_message_handler({
      command:'http_report_error',
      error:'Error in response: '+err.message
    });
  }
}

function connect_to_websocket() {
  if (KBUCKET_HUB_URL) {
    var URL=require('url').URL;
    var url=new URL(KBUCKET_HUB_URL);
    if (url.protocol=='http:')
      url.protocol='ws';
    else
      url.protocol='wss';
    url=url.toString();
    const ws = new WebSocket(url, {
      perMessageDeflate: false
    });
    ws.on('open', function open() {
      send_message_to_hub({
        command:'register_kbucket_share',
        info:{
          share_protocol:KBUCKET_SHARE_PROTOCOL,
          share_host:KBUCKET_SHARE_HOST,
          share_port:KBUCKET_SHARE_PORT,
          public_key:KBSC.publicKey()
        }
      });
      index_files();
    });
    ws.on('close',function() {
      if (debugging) {
        console.log (`Websocket closed. Aborting.`);
      }
      process.exit(-1);
    });
    ws.on('message', (message_str) => {
      var msg=parse_json(message_str);
      if (!msg) {
        console.log ('Unable to parse message. Closing websocket.');
        ws.close();
        return;
      }
      if (debugging) {
        console.log ('====================================== received message');
        console.log (JSON.stringify(msg,null,4).slice(0,400));
      }

      if (msg.command=='http_initiate_request') {
        if (msg.request_id in HTTP_REQUESTS) {
          console.log (`Request with id=${msg.request_id} already exists (in http_initiate_request). Closing websocket.`);
          ws.close();
          return;   
        }
        HTTP_REQUESTS[msg.request_id]=new HttpRequest(function(msg_to_hub) {
          msg_to_hub.request_id=msg.request_id;
          send_message_to_hub(msg_to_hub);
        });
        HTTP_REQUESTS[msg.request_id].initiateRequest(msg);
      }
      else if (msg.command=='http_write_request_data') {
        if (!(msg.request_id in HTTP_REQUESTS)) {
          console.log (`No request found with id=${msg.request_id} (in http_write_request_data). Closing websocket.`);
          ws.close();
          return;  
        }
        var REQ=HTTP_REQUESTS[msg.request_id];
        var data=Buffer.from(msg.data_base64, 'base64');
        REQ.writeRequestData(data);
      }
      else if (msg.command=='http_end_request') {
        if (!(msg.request_id in HTTP_REQUESTS)) {
          console.log (`No request found with id=${msg.request_id} (in http_end_request). Closing websocket.`);
          ws.close();
          return;  
        }
        var REQ=HTTP_REQUESTS[msg.request_id];
        REQ.endRequest();
      }
      else {
        console.log (`Unexpected command: ${msg.command}. Closing websocket.`);
        ws.close();
        return;  
      }
    });

    function index_files() {
      index_files_in_subdirectory('',function(err) {
        if (err) {
          console.error(`Error computing prv index: ${err}. Aborting.`);
          process.exit(-1);
        }
      });
    }

    var queued_files_for_indexing={};
    var indexed_files={};
    start_indexing_queued_files();
    function start_indexing_queued_files() {
      var num_before=Object.keys(queued_files_for_indexing).length;
      index_queued_files(function() {
        setTimeout(function() {
          var num_after=Object.keys(queued_files_for_indexing).length;
          if ((num_before>0)&&(num_after==0)) {
            console.log (`Done indexing ${Object.keys(indexed_files).length} files.`);
          }
          start_indexing_queued_files();
        },100);
      });
    }
    function index_queued_files(callback) {
      var keys=Object.keys(queued_files_for_indexing);
      async.eachSeries(keys,function(key,cb) {
        index_queued_file(key,function() {
          cb();
        });
      },function() {
        callback();
      });
    }
    function index_queued_file(key,callback) {
      if (!(key in queued_files_for_indexing)) {
        callback();
        return;
      }
      var relfilepath=key;
      delete queued_files_for_indexing[key];
      if (!require('fs').existsSync(share_directory+'/'+relfilepath)) {
        console.log ('File no longer exists: '+relfilepath);
        send_message_to_hub({command:'set_file_info',path:relfilepath,prv:undefined});
        if (relfilepath in indexed_files)
          delete indexed_files[relfilepath];
        callback();
        return;
      }
      console.log (`Computing prv for: ${relfilepath}...`);
      compute_prv(relfilepath,function(err,prv) {
        if (err) {
          callback(err);
          return;
        }
        send_message_to_hub({command:'set_file_info',path:relfilepath,prv:prv});
        indexed_files[relfilepath]=true;
        callback();
      });
    }
    watcher.watch(share_directory,{ignoreInitial:true}).on('all',function(evt,path) {
      if (!path.startsWith(share_directory+'/')) {
        console.warn('Watched file does not start with expected directory',path,share_directory);
        return;
      }
      var relpath=path.slice((share_directory+'/').length);
      if (relpath.startsWith('.kbucket')) {
        return;
      }
      if (is_indexable(relpath)) {
        queued_files_for_indexing[relpath]=true;
      }
    });


    function index_files_in_subdirectory(subdirectory,callback) {
      var path0=require('path').join(share_directory,subdirectory);
      fs.readdir(path0,function(err,list) {
        if (err) {
          callback(err.message);
          return;
        }
        var relfilepaths=[],reldirpaths=[];
        async.eachSeries(list,function(item,cb) {
          if ((item=='.')||(item=='..')||(item=='.kbucket')) {
            cb();
            return;
          }
          fs.stat(require('path').join(path0,item),function(err0,stat0) {
            if (err0) {
              callback(`Error in stat of file ${item}: ${err0.message}`);
              return;
            }
            if (stat0.isFile()) {
              relfilepaths.push(require('path').join(subdirectory,item));
            }
            else if (stat0.isDirectory()) {
              if (!is_excluded_directory_name(item)) {
                reldirpaths.push(require('path').join(subdirectory,item));
              }
            }
            cb();
          });
        },function() {
          for (var i in relfilepaths) {
            if (is_indexable(relfilepaths[i])) {
              queued_files_for_indexing[relfilepaths[i]]=true;
            }
          }
          async.eachSeries(reldirpaths,function(reldirpath,cb) {
            index_files_in_subdirectory(reldirpath,function(err) {
              if (err) {
                callback(err);
                return;
              }
              cb();
            });
          },function() {
            callback(null);
          });
        });
      });
    }



    function filter_file_name_for_cmd(fname) {
      fname=fname.split(' ').join('\\ ');
      fname=fname.split('$').join('\\$');
      return fname;
    }

    function compute_prv(relpath,callback) {
      var prv_obj=KBSC.getPrvFromCache(relpath);
      if (prv_obj) {
        callback(null,prv_obj);
        return;
      }
      var cmd=`ml-prv-stat ${filter_file_name_for_cmd(share_directory+'/'+relpath)}`;
      run_command_and_read_stdout(cmd,function(err,txt) {
        if (err) {
          callback(err);
          return;
        }
        var obj=parse_json(txt.trim());
        if (!obj) {
          callback(`Error parsing json output in compute_prv for file: ${relpath}`);
          return;
        }
        KBSC.savePrvToCache(relpath,obj);
        callback(null,obj);
      });
    }

    function send_message_to_hub(obj) {
      //note we send both of these for now, but in future, we need to just send kbshare_id
      obj.share_key=KBSC.kbShareId();
      obj.kbshare_id=KBSC.kbShareId();
      send_json_message(obj);
    }
    function send_json_message(obj) {
      if (debugging) {
        if (obj.command!='set_file_info') {
          console.log ('------------------------------- sending message');
          console.log (JSON.stringify(obj,null,4).slice(0,400));
        }
      }
      ws.send(JSON.stringify(obj));
    }

  }
}

function KBShareConfig(share_directory) {
  this.initialize=function(callback) {initialize(callback);};
  this.kbShareId=function() {return kbShareId();};
  this.getPrvFromCache=function(relpath) {return get_prv_from_cache(relpath);};
  this.savePrvToCache=function(relpath,prv) {return save_prv_to_cache(relpath,prv);};
  this.publicKey=function() {return publicKey();};

  var m_config_dir=share_directory+'/.kbucket';
  var m_config_file_path=m_config_dir+'/kbshare.json';

  if (!require('fs').existsSync(m_config_dir)) {
    require('fs').mkdirSync(m_config_dir);
  }
  if (!require('fs').existsSync(m_config_dir+'/prv_cache')) {
    require('fs').mkdirSync(m_config_dir+'/prv_cache');
  }

  function initialize(callback) {
    async.series([init_step1,init_step2],
      function() {
        callback(null);
      }
    );
    function init_step1(cb) {
      if (get_config('kbshare_id')) {
        cb();
        return;
      }
      generate_pem_files_and_kbshare_id(function() {
        callback();
      });
    }
    function init_step2(cb) {
      start_the_cleaner();
      cb();
    }
  }

  function generate_pem_files_and_kbshare_id(callback) {
    var pair = keypair();
    var private_key=pair.public;
    var public_key=pair.public;
    write_text_file(m_config_dir+'/private.pem',private_key);
    write_text_file(m_config_dir+'/public.pem',public_key);
    var list=public_key.split('\n');
    var share_id=list[1].slice(0,10); //important
    set_config('kbshare_id',share_id);
    callback();
  }

  function kbShareId() {
    return get_config('kbshare_id');
  }

  function get_config(key) {
    var config=read_json_file(m_config_file_path)||{};
    return config[key];
  }
  function set_config(key,val) {
    var config=read_json_file(m_config_file_path)||{};
    config[key]=val;
    if (!write_json_file(m_config_file_path,config)) {
      console.error('Unable to write to file: '+m_config_file_path+'. Aborting.');
      process.exit(-1);
    }
  }

  function publicKey() {
    var public_key=read_text_file(m_config_dir+'/public.pem');
    //var list=public_key.split('\n');
    return public_key;
  }

  function get_prv_cache_fname(path) {
    if (!path) return '';
    return m_config_dir+'/prv_cache/'+sha1(path).slice(0,10)+'.json';
  }

  function get_prv_from_cache(relpath) {
    var cache_fname=get_prv_cache_fname(relpath);
    if (!require('fs').existsSync(cache_fname)) {
      return null;
    }
    var obj=read_json_file(cache_fname);
    if (!obj) return null;
    if (!prv_cache_object_matches_file(obj,share_directory+'/'+relpath)) {
      return null;
    }
    return obj.prv;
  }
  function prv_cache_object_matches_file(obj,path) {
    if (!obj) return false;
    try {
      var stat0=require('fs').statSync(path);
    }
    catch(err) {
      return false;
    }
    if (stat0.size!=obj.size) {
      return false;
    }
    if (stat0.mtime+''!=obj.mtime) {
      return false;
    }
    if (!obj.prv) return false;
    return true;
  }

  function save_prv_to_cache(relpath,prv) {
    var cache_fname=get_prv_cache_fname(relpath);
    var stat0=require('fs').statSync(share_directory+'/'+relpath);
    var obj={};
    obj.path=relpath;
    obj.size=stat0.size;
    obj.mtime=stat0.mtime+'';
    obj.prv=prv;
    write_json_file(cache_fname,obj);
  }

  function start_the_cleaner() {
    cleanup(function(err) {
      if (err) {
        console.error(err);
        console.error('Aborting');
        process.exit(-1);
        return;
      }
      setTimeout(start_the_cleaner,1000);
    });
  }
  function cleanup(callback) {
    cleanup_prv_cache(function(err) {
      if (err) {
        callback(err);
        return;
      }
      callback(null);
    });
  }
  function cleanup_prv_cache(callback) {
    var prv_cache_dir=m_config_dir+'/prv_cache';
    require('fs').readdir(prv_cache_dir,function(err,files) {
      if (err) {
        callback('Error in cleanup_prv_cache:readdir: '+err.message);
        return;
      }
      async.eachSeries(files,function(file,cb) {
        cleanup_prv_cache_file(prv_cache_dir+'/'+file,function(err) {
          if (err) {
            callback(err);
            return;
          }
          cb();
        });
      });
    });
  }
  function cleanup_prv_cache_file(cache_filepath,callback) {
    var obj=read_json_file(cache_filepath);
    if (!obj) {
      safe_remove_file(cache_filepath);
      callback(null);
      return;
    }
    var relpath1=obj.path;
    if (!is_indexable(relpath1)) {
      safe_remove_file(cache_filepath);
      callback(null);
      return;
    }
    if (get_prv_cache_fname(relpath1)!=cache_filepath) {
      safe_remove_file(cache_filepath);
      callback(null);
      return;  
    }
    if (!prv_cache_object_matches_file(obj,share_directory+'/'+relpath1)) {
      safe_remove_file(cache_filepath);
      callback(null);
      return;
    }
    callback(null);
  }
  function safe_remove_file(cache_filepath) {
    require('fs').unlink(cache_filepath,function(err) {
    });
  }
}


function run_command_and_read_stdout(cmd,callback) {
  var P;
  try {
    P=require('child_process').spawn(cmd,{shell:true});
  }
  catch(err) {
    callback(`Problem launching ${cmd}: ${err.message}`);
    return;
  }
  var txt='';
  P.stdout.on('data',function(chunk) {
    txt+=chunk.toString();
  });
  P.on('close',function(code) {
    callback(null,txt);
  });
  P.on('error',function(err) {
    callback(`Problem running ${cmd}: ${err.message}`);
  })
}

function CLParams(argv) {
  this.unnamedParameters=[];
  this.namedParameters={};

  var args=argv.slice(2);
  for (var i=0; i<args.length; i++) {
    var arg0=args[i];
    if (arg0.indexOf('--')===0) {
      arg0=arg0.slice(2);
      var ind=arg0.indexOf('=');
      if (ind>=0) {
        this.namedParameters[arg0.slice(0,ind)]=arg0.slice(ind+1);
      }
      else {
        this.namedParameters[arg0]='';
        if (i+1<args.length) {
          var str=args[i+1];
          if (str.indexOf('-')!=0) {
            this.namedParameters[arg0]=str;
            i++;  
          }
        }
      }
    }
    else if (arg0.indexOf('-')===0) {
      arg0=arg0.slice(1);
      this.namedParameters[arg0]='';
    }
    else {
      this.unnamedParameters.push(arg0);
    }
  }
};

function make_random_id(len) {
    var text = "";
    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for( var i=0; i < len; i++ )
        text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
}

function parse_json(str) {
  try {
    return JSON.parse(str);
  }
  catch(err) {
    return null;
  }
}

function read_json_file(fname) {
  try {
    var txt=require('fs').readFileSync(fname,'utf8')
    return parse_json(txt);
  }
  catch(err) {
    return null;
  }
}

function read_text_file(fname) {
  try {
    var txt=require('fs').readFileSync(fname,'utf8')
    return txt;
  }
  catch(err) {
    return null;
  }
}

function write_json_file(fname,obj) {
  try {
    require('fs').writeFileSync(fname,JSON.stringify(obj,null,4));
    return true;
  }
  catch(err) {
    return false;
  }
}

function write_text_file(fname,txt) {
  try {
    require('fs').writeFileSync(fname,txt);
    return true;
  }
  catch(err) {
    return false;
  }
}

function is_indexable(relpath) {
  var list=relpath.split('.');
  for (var i=0; i<list.length-1; i++) {
    if (is_excluded_directory_name(list[i]))
      return false;
  }
  return true;
}

function is_excluded_directory_name(name) {
  var to_exclude=['node_modules','.git','.kbucket'];
  return (to_exclude.indexOf(name)>=0);
}