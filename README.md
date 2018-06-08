# KBucket

System for sharing data for scientific research.

Developers: Jeremy Magland, with contributions from Dylan Simon and Alex Morley

Flatiron Institute, a divison of Simons Foundation

## Philosophy

In many scientific fields it is essential to be able to exchange, share, archive, and publish experimental data. However, raw data files needed to reproduce results can be enormous. The philosophy of KBucket is to separate file contents from the files themselves, and to host data content where it most naturally lives, that is, in the lab where it was generated. By replacing large data files by tiny universal pointers called .prv files (analogous to magnet links in torrent), we open up diverse ways for sharing datasets, studies, and results.

For example, sometimes it is useful to email data to a collaborator, while other times it's nice to post it to slack, or to maintain a study on github, or share a directory structure on dropbox, or google drive, or post it to a website or forum. However, if the files are many Gigabytes or even Terabytes, many of those options become unfeasible without a system like KBucket.

## Overview and usage

After installing kbucket on your Linux or Mac system, you can do the following:

#### Sharing a directory of data with the system

```
cd /path/to/data/directory
kbucket-share .
```

You will then be prompted to interactively configure the share, as follows:

```
magland@dub:~/kbucket_data/datasets/dataset_01$ kbucket-share .
Creating new kbucket share configuration in /home/magland/kbucket_data/datasets/dataset_01/.kbucket ...
Initializing configuration...

? Name for this KBucket share: dataset_01
? Are sharing this data for scientific research purposes (yes/no)? yes
? Brief description of this KBucket share: An example dataset
? Owner's name (i.e., your full name): Jeremy Magland
? Owner's email (i.e., your email): my@email.edu
? Share all data recursively contained in the directory /home/magland/kbucket_data/datasets/dataset_01? (yes/no) yes
? Connect to hub: https://kbucket.flatironinstitute.org

Listening on port 2001
Web interface: http://localhost:2001/bad81d93d623/web
Connecting to parent hub: https://kbucket.flatironinstitute.org
Connected to parent hub: https://kbucket.flatironinstitute.org
```

Let's go through what all this means, and what has actually happened.

I am now hosting a new kbucket share (kb-share), which allows other researchers to access the files within this shared directory provided that they know the SHA-1 hashes of those files (or have the corresponding .prv files). Here are some details on the configuration options:

**Name for the kb-share.** This is simply a name that could be useful for logging or other miscellaneous purposes.

**Sharing for scientific research purposes?** This system is intended only for scientific research purposes, and therefore users are required to type "yes". We don't want people using KBucket to share illegal media content, for example. It's not easy to enforce this, but at least we make it clear that this would be a no-no.

**Brief description.** Not essential, just could be useful to have a description of the kb-share.

**Owner's name and email.** If a particular kb-share is acting suspiciously, it's helpful to be able to contact that user by e-mail, as a warning, before blacklisting particular shares.

**Confirm share recursive?** The user is required to type "yes" so they understand that they are exposing data in that directory to the general internet.

**Connect to hub.** This crucial field specifies the url of the kbucket hub we are connecting to. More about hubs below.

KBucket will create a new directory called .kbucket within this shared directory where it will store the configuration as well as a private/public RSA PEM key pair. The configuration options entered are contained in the .kbucket/kbnode.json file and can be edited by hand.

To stop sharing the directory, simply use [ctrl]+c to cancel the process. To begin sharing again, use the above command. The configuration will be remembered as the default, but you will be prompted to verify the answers again, unless you use the --auto flag as follows:

```
cd /path/to/data/directory
kbucket-share . --auto
```

This is useful if you don't want to press [enter] a bunch of times.

#### Providing access to shared files

Once kbucket-share is running, and assuming we are connected to a hub within the KBucket network, the files in this directory can be accessed from any computer on the internet via http/https. However, one piece of information is needed in order to locate and download any particular file: the SHA-1 hash of the file. Much like a magnet link for torrent, this serves as the universal locator for that file. This file hash is contained (along with some other information) in the .prv file.

To create a .prv file, simply execute

```
kb-prv-create /path/to/data/directory/file1.dat file1.dat.prv
```

This will create a new, tiny text file called file1.dat.prv containing the SHA-1 hash required to locate the file on the system KBucket. Now send that file (email/slack/google-drive/github/dropbox) to your collaborator in order to provide access. Your colleague can then download (retrieve) the file via:

```
kb-prv-download file1.dat.prv file1.dat
```

Or, if the file is very large, it may be more convenient to load only portions of the file (the http/https protocol for KBucket supports the range header). Therefore our file1.dat.prv could be passed as an input to a visualizer that incrementally loads only parts of the file needed for viewing. There are many other advantages of the .prv file system for enabling web applications and data analysis on remote machines. These will be discussed elsewhere.

It is also possible to create a .prvdir file encapsulating the .prv information for all the files in a particular directory.

```
kb-prv-create /path/to/data/directory directory.prvdir
```

This creates a relatively small JSON text file that can be also be shared with colleagues. Downloading the entire directory may then be accomplished as follows:

```
kb-prv-download directory.prvdir directory_copy
```

#### What's actually happening with the data?

Are you interested to know how the data was transferred from one computer to another? Of course you are. Note that the .prv file contains no information about the computer it was created on. No ip addresses, routing information, etc. It simply contains the SHA-1 hash, the size of the file, and a couple other fields for convenience. Since we assume that the SHA-1 hash is sufficient to uniquely identify the file, that is the only piece of information needed to locate and retrieve the file content. This is useful because sometimes we need to change the names of files and directories, or move data from one computer to another, or replicate data on several servers. 

#### Shares and hubs: the KBucket network

The KBucket network is organized as a collection of disjoint trees. The root node of the main tree is hosted by us (https://kbucket.flatironinstitute.org), but you can easily create your own network (disconnected from ours) with your own root node. For simplicity let's just consider it as one big connected tree for now.

The leaves of the tree are called kb-shares and the other nodes are called kb-hubs. As mentioned there is one root kb-hub hosted by us. Each other kb-node (kb-share or kb-hub) is connected to a single parent kb-hub via websocket. Each kb-share sends (via websocket) the SHA-1 hashes of all the files in its directory to its parent hub who maintains an index for fast lookup. Because all of the kb-nodes are connected to one another by a network of sockets, any of the kb-hubs may be queried with the hash to retrieve the corresponding original file's location.

Once the client (computer trying to retrieve the file) knows the URL to the kb-share containing the desired file, it can access that file content directly via http request without burdening the other computers in the network. This is particularly important since we wouldn't want all network traffic passing through the root node.

But what if the kb-share hosting the file is behind a firewall? This is where the network of kb-hubs becomes important. If the client cannot access the share computer directly, it will try its parent hub, and then that hub's parent, etc. In the worst case it will need to access the file from the root node (which of course has an open public port). In any case, the file content will be proxied through the websockets and piped to the client.

There is opportunity for quite a bit of optimization in this framework in terms of intelligent caching, and determining the optimal way to deliver content from one location to another. Since at this point, there is very little demand on the system, such optimizations are lower priority for the time being.

#### Hosting a kb-hub

When creating a new

[IN PROGRESS.... to be continued]
