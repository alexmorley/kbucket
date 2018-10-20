exports.prv_locate = prv_locate;
exports.prv_create = prv_create;
exports.prv_download = prv_download;
exports.compute_file_sha1 = compute_file_sha1;

var common = require(__dirname + '/common.js');
var db_utils = require(__dirname + '/db_utils.js');
var sha1 = require('node-sha1');
var url_exists = require('url-exists');
var async = require('async');
var request = require('request');

const KBClient = require('kbclient').v1;

function prv_download(prv_fname, opts, callback) {
  opts.remote = true;
  opts.local = true;
  console.log('Locating file...');
  prv_locate(prv_fname, opts, function(err, url, obj) {
    if (err) {
      callback('Unable to locate file: ' + err);
      return;
    }
    if (opts.output) {
      proceed();
    } else {
      if (!is_url(url)) {
        console.log(`File is already on local system: ${url}`);
        opts.output = url;
        callback(null, opts.output);
        return;
      }
      console.log('Creating file path for download...');
      opts.output = get_file_path_for_download(obj.original_checksum);
      if (require('fs').existsSync(opts.output)) {
        console.log('Output file already exists...');
        compute_file_sha1(opts.output, function(err, sha1) {
          if ((!err) && (sha1 == obj.original_checksum)) {
            console.log('And checksum matches, so no need to download...');
            callback(null, opts.output);
            return;
          }
          console.log('But checksums do not match, so re-downloading...');
          proceed();
        });
      } else {
        proceed();
      }
    }

    function proceed() {
      if (!is_url(url)) {
        console.log(`Copying "${url}" to "${opts.output}" ...`);
        copy_file(url, opts.output, function(err) {
          if (err) {
            callback('Error copying: ' + err);
            return;
          }
          callback(null, opts.output);
        });
        return;
      }
      console.log(`Downloading "${url}" to "${opts.output}" ...`);
      download_url(url, opts.output, function(err) {
        if (err) {
          callback('Error downloading: ' + err);
          return;
        }
        console.log('Computing checksum...');
        compute_file_sha1(opts.output, function(err, sha1) {
          if (err) {
            callback('Error computing sha1 of downloaded file: ' + err);
            return;
          }
          if (sha1 != obj.original_checksum) {
            callback(`SHA-1 of downloaded file does not match expected. ${sha1} <> ${obj.original_checksum}`);
            return;
          }
          console.log('Done.');
          callback(null, opts.output);
        })
      });
    }

  });


}

function download_url(url, output_path, callback) {
  if (require('fs').existsSync(output_path)) {
    require('fs').unlinkSync(output_path);
  }
  var r = request(url);
  r.on('response', function(res) {
    var dest = require('fs').createWriteStream(output_path + '.tmp');
    res.pipe(dest);
    dest.on('error', function(err) {
      finalize('Error writing download: ' + err.message);
    });
    dest.on('finish', function() {
      require('fs').renameSync(output_path + '.tmp', output_path);
      finalize(null);
    });
  });
  r.on('error', function(err) {
    finalize('Error in download request: ' + err.message);
  });

  function finalize(errstr) {
    if (!callback) return;
    callback(errstr);
    callback = null;
  }
}

function copy_file(input_path, output_path, callback) {
  if (require('fs').existsSync(output_path)) {
    require('fs').unlinkSync(output_path);
  }
  var in_stream = require('fs').createReadStream(input_path);
  var out_stream = require('fs').createWriteStream(output_path + '.tmp');
  in_stream.pipe(out_stream);
  out_stream.on('error', function(err) {
    finalize('Error writing to file: ' + err.message);
  });
  out_stream.on('finish', function() {
    require('fs').renameSync(output_path + '.tmp', output_path);
    finalize(null);
  });

  function finalize(errstr) {
    if (!callback) return;
    callback(errstr);
    callback = null;
  }
}

function get_file_path_for_download(sha1) {
  const downloads_directory = common.temporary_directory() + '/downloads';
  common.mkdir_if_needed(downloads_directory);
  return downloads_directory + '/' + sha1;
}

// prv_fname - name of prv file
// opts.
//  local
//  remote
//  sha1,
//  size,
//  fcs,
//  original_path
function prv_locate(prv_fname, opts, callback) {
  // Locate file corresponding to prv file or object
  opts = opts || {};

  if ((prv_fname.startsWith('kbucket://'))||(prv_fname.startsWith('sha1://'))) {
  	let KBC = new KBClient();
  	if ('download' in opts) {
      supress_console_info();
      KBC.realizeFile(prv_fname, {})
        .then(function(url2) {
          restore_console_info();
          callback(null, url2, null);
        })
        .catch(function(err) {
          restore_console_info();
          callback('Error searching kbucket: ' + err.message);
        });
    } else {
    	supress_console_info();
      KBC.locateFile(prv_fname, {})
        .then(function(url2) {
        	restore_console_info();
          callback(null, url2, null);
        })
        .catch(function(err) {
        	restore_console_info();
          callback('Error searching kbucket: ' + err.message);
        });
    }
  	return;
  }

  if (('local' in opts) && ('remote' in opts)) {
    // if both local and remote options are specified, then let's search local first, then remote
    delete opts['remote'];
    prv_locate(prv_fname, opts, function(err, path_or_url, obj) {
      if (err) {
        callback(err);
        return;
      }
      if (path_or_url) {
        callback(null, path_or_url, obj);
        return;
      }
      delete opts['local'];
      opts['remote'] = true;
      prv_locate(prv_fname, opts, callback);
      return;
    });
    return;
  }


  opts.verbose = Number(opts.verbose || 0);
  var obj = null;
  if (prv_fname) {
    // read the prv file and store the object
    obj = common.read_json_file(prv_fname);
    if (!obj) {
      callback('Cannot read json file: ' + prv_fname);
      return;
    }
  } else {
    // construct the prv object from the opts
    obj = {
      original_checksum: opts.sha1,
      original_size: opts.size,
      original_fcs: opts.fcs,
      original_path: opts.original_path || '',
      prv_version: '0.11'
    };
  }

  if (opts.verbose >= 1) {
    console.log('Searching for prv object:');
    console.log(JSON.stringify(obj, null, 4));
  }

  if ('remote' in opts) {
    // search remotely
    let KBC = new KBClient();
    if ('download' in opts) {
      supress_console_info();
      KBC.realizeFile('sha1://' + obj.original_checksum, {})
        .then(function(url2) {
          restore_console_info();
          callback(null, url2, obj);
        })
        .catch(function(err) {
          restore_console_info();
          callback('Error checking on kbucket: ' + err.message);
        });
    } else {
    	supress_console_info();
      KBC.locateFile('sha1://' + obj.original_checksum, {})
        .then(function(url2) {
        	restore_console_info();
          callback(null, url2, obj);
        })
        .catch(function(err) {
        	restore_console_info();
          callback('Error checking on kbucket: ' + err.message);
        });
    }
    return;
    /*
    var kbucket_url=process.env.KBUCKET_URL;
    var url=kbucket_url+'/find/'+obj.original_checksum;
    //var url2=kbucket_url+'/download/'+obj.original_checksum;
    if (opts.verbose>=1) {
    	console.log ('Getting: '+url);
    }
    nodejs_http_get_json(url,{},function(obj2) {
    	if (!obj2.success) {
    		callback('Error checking on kbucket: '+obj2.error);
    		return;
    	}
    	obj2=obj2.object;
    	if (!obj2.success) {
    		callback('Error checking on kbucket (*): '+obj2.error);
    		return;
    	}
    	if (!obj2.found) {
    		callback('File not found on kbucket.');
    		return;
    	}
    	var candidate_urls=obj2.urls||[];
    	find_existing_url(candidate_urls,function(url2) {
    		if (!url2) {
    			callback('Found file, but none of the urls seem to work.');
    			return;
    		}
    		callback(null, url2, obj);
    	});
    });
    return;
    */
  }

  if ((obj.original_path) && (require('fs').existsSync(obj.original_path))) {
    // try the original path
    if (opts.verbose >= 1) {
      console.log('Trying original path: ' + obj.original_path);
    }
    sumit.compute_file_sha1(obj.original_path, function(err, sha1) {
      if ((!err) && (sha1 == obj.original_checksum)) {
        callback(null, obj.original_path, obj);
        return;
      }
      proceed();
    });
  } else {
    proceed();
  }

  function proceed() {

    var prv_search_paths = common.prv_search_directories();

    var sha1 = obj.original_checksum || '';
    var fcs = obj.original_fcs || '';
    var size = obj.original_size || '';
    if (!sha1) {
      callback('original_checksum field not found in prv file: ' + prv_fname);
      return;
    }
    if (opts.verbose >= 1) {
      console.log('sumit.find_doc_by_sha1 ' + sha1 + ' ' + prv_search_paths.join(':'));
    }
    sumit.find_doc_by_sha1(sha1, prv_search_paths, opts, function(err, doc0) {
      if (err) {
        callback(err);
        return;
      }
      if (doc0) {
        callback('', doc0.path, obj);
        return;
      }
      if ((!sha1) || (!size) || (!fcs)) {
        callback('Missing fields in prv file: ' + prv_fname);
        return;
      }

      if (opts.verbose >= 1) {
        console.log(`Document not found in database, searching on disk...`);
      }
      common.foreach_async(prv_search_paths, function(ii, path0, cb) {
        prv_locate_in_path(path0, sha1, fcs, size, function(err, fname) {
          if (err) {
            callback(err);
            return;
          }
          if (fname) {
            callback('', fname, obj);
            return;
          }
          cb();
        });
      }, function() {
        if (opts.verbose >= 1) {
          console.log('Not found.');
        }
        callback('', '', null); //not found
      });
    });
  }
}

let hold_console_info = console.info;

function supress_console_info() {
  console.info = function() {};
}

function restore_console_info() {
  console.info = hold_console_info;
}

function find_existing_url(candidate_urls, callback) {
  async.eachSeries(candidate_urls, function(candidate_url, cb) {
    url_exists(candidate_url, function(err, exists) {
      if ((!err) && (exists)) {
        callback(candidate_url);
        return;
      }
      cb();
    })
  }, function() {
    callback('');
  });
}

function prv_create(fname, callback) {
  var stat0 = common.stat_file(fname);
  if (!stat0) {
    callback('Unable to stat file in prv_create: ' + fname);
    return;
  }
  compute_file_sha1(fname, function(err, sha1) {
    if (err) {
      callback(err);
      return;
    }
    var sha1_head = compute_sha1_of_head(fname, 1000);
    var fcs = 'head1000-' + sha1_head;
    var obj = {
      original_checksum: sha1,
      original_size: stat0.size,
      original_fcs: fcs,
      original_path: require('path').resolve(fname),
      prv_version: '0.11'
    };
    callback('', obj);
  });
}


var sumit = {};
sumit.file_matches_doc = function(path, doc0) {
  var stat0 = common.stat_file(path);
  if (stat0) {
    if ((stat0.size == doc0.size) && (stat0.mtime.toISOString() == doc0.mtime) && (stat0.ctime.toISOString() == doc0.ctime) && (stat0.ino == doc0.ino)) {
      return true;
    }
  }
  return false;
};
sumit.find_doc_by_sha1 = function(sha1, valid_prv_search_paths, opts, callback) {
  if (opts.verbose >= 1) {
    console.log(`Finding documents for sha1=${sha1}`);
  }
  db_utils.findDocuments('sumit', {
    sha1: sha1
  }, function(err, docs) {
    if (err) {
      callback(err);
      return;
    }
    if (docs.length === 0) {
      callback(null, null);
      return;
    }
    if (opts.verbose >= 1) {
      console.log(`Found ${docs.length} documents.`);
    }
    for (var i in docs) {
      var doc0 = docs[i];
      if (sumit.file_matches_doc(doc0.path, doc0)) {
        for (var i in valid_prv_search_paths) {
          if (doc0.path.indexOf(valid_prv_search_paths[i]) == 0) {
            callback(null, doc0);
            return;
          }
        }
      }
    }
    callback(null, null);
  });

}
sumit.find_doc_by_path = function(path, callback) {
  db_utils.findDocuments('sumit', {
    path: path
  }, function(err, docs) {
    if (err) {
      callback(err);
      return;
    }
    if (docs.length === 0) {
      callback(null, null);
      return;
    }
    for (var i in docs) {
      var doc0 = docs[i];
      if (sumit.file_matches_doc(doc0.path, doc0)) {
        callback(null, doc0);
        return;
      }
    }
    callback(null, null);
  });
}
sumit.compute_file_sha1 = function(path, callback) {
  var stat0 = common.stat_file(path);
  if (!stat0) {
    callback('Unable to stat file: ' + path, '');
    return;
  }
  if (!stat0.isFile()) {
    callback('Not file type: ' + path, '');
    return;
  }
  var is_small_file = (stat0.size < 1000);
  if (is_small_file) {
    do_compute_sha1();
    return;
  }
  sumit.find_doc_by_path(path, function(err, doc0) {
    if (err) {
      callback(err);
      return;
    }
    if (doc0) {
      callback(null, doc0.sha1);
      return;
    }
    do_compute_sha1();
  });

  function do_compute_sha1() {
    var stream = require('fs').createReadStream(path);
    sha1(stream, function(err, hash) {
      if (err) {
        callback('Error: ' + err);
        return;
      }
      var doc0 = {
        _id: path,
        path: path,
        sha1: hash,
        size: stat0.size,
        ctime: stat0.ctime.toISOString(),
        mtime: stat0.mtime.toISOString(),
        ino: stat0.ino
      };
      if (is_small_file) {
        callback('', doc0.sha1);
      } else {
        db_utils.saveDocument('sumit', doc0, function(err) {
          if (err) {
            callback(err);
            return;
          }
          callback('', doc0.sha1);
        });
      }
    });
  }

}

function compute_file_sha1(path, callback) {
  sumit.compute_file_sha1(path, callback);
}

function compute_sha1_of_head(fname, num_bytes) {
  var buf = read_part_of_file(fname, 0, num_bytes);
  if (!buf) return null;
  return sha1(buf);
}

function file_matches_fcs_section(path, fcs_section) {
  var tmp = fcs_section.split('-');
  if (tmp.length != 2) {
    console.warn('Invalid fcs section: ' + fcs_section);
    return false;
  }
  if (tmp[0] == 'head1000') {
    var fcs0 = compute_sha1_of_head(path, 1000);
    if (!fcs0) return false;
    return (fcs0 == tmp[1]);
  } else {
    console.warn('Unexpected head section: ' + fcs_section);
    return false;
  }
}

function read_part_of_file(path, start, num_bytes) {
  var stat0 = common.stat_file(path);
  if (!stat0) return null;
  if (stat0.size < start + num_bytes)
    num_bytes = stat0.size - start;
  if (num_bytes < 0) return null;
  if (num_bytes == 0) return new Buffer(0);
  var buf = new Buffer(num_bytes);
  var fd = require('fs').openSync(path, 'r');
  require('fs').readSync(fd, buf, 0, num_bytes, start);
  require('fs').closeSync(fd);
  return buf;
}

function file_matches_fcs(path, fcs) {
  var list = fcs.split(';');
  for (var i in list) {
    if (list[i]) {
      if (!file_matches_fcs_section(path, list[i]))
        return false;
    }
  }
  return true;
}

function prv_locate_in_path(path, sha1, fcs, size, callback) {
  var files = common.read_dir_safe(path);
  common.foreach_async(files, function(ii, file, cb) {
    var fname = path + '/' + file;
    var stat0 = common.stat_file(fname);
    if (stat0) {
      if (stat0.isFile()) {
        if (stat0.size == size) { //candidate
          sumit.find_doc_by_path(fname, function(err, doc0) {
            if (err) {
              callback(err);
              return;
            }
            if (doc0) {
              if (doc0.sha1 == sha1) {
                callback('', fname)
                return;
              } else {
                cb();
              }
            } else {
              if (file_matches_fcs(fname, fcs)) {
                sumit.compute_file_sha1(fname, function(err, sha1_of_fname) {
                  if (sha1_of_fname == sha1) {
                    callback('', fname);
                    return;
                  } else {
                    cb();
                  }
                });
              } else {
                cb();
              }
            }
          });
        } else {
          cb();
        }
      } else if (stat0.isDirectory()) {
        if (common.starts_with(file, '.')) { //hidden directory
          cb();
          return;
        }
        prv_locate_in_path(fname, sha1, fcs, size, function(err, fname0) {
          if (fname0) {
            callback('', fname0);
            return;
          }
          cb();
        });
      } else {
        cb();
      }
    }
  }, function() {
    callback('', ''); //not found
  });
}

function nodejs_http_get_text(url, headers, callback) {
  if (!callback) {
    callback = headers;
    headers = null;
  }
  require('request').get({
    url: url,
    headers: headers
  }, function(err, response, body) {
    if (err) {
      if (callback) callback({
        success: false,
        error: err.message
      });
      return;
    }
    if (callback) callback({
      success: true,
      text: body
    });
  });
}

function nodejs_http_get_json(url, headers, callback) {
  if (!callback) {
    callback = headers;
    headers = null;
  }
  nodejs_http_get_text(url, headers, function(tmp) {
    if (!tmp.success) {
      callback(tmp);
      return;
    }
    var obj;
    try {
      obj = JSON.parse(tmp.text);
    } catch (err) {
      console.log('Error parsing: ' + tmp.text);
      callback({
        success: false,
        error: 'Error parsing.'
      });
      return;
    }
    callback({
      success: true,
      object: obj
    });
  });
}

function is_url(path_or_url) {
  return ((path_or_url.startsWith('http://')) || (path_or_url.startsWith('https://')));
}
