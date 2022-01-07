const express = require("express");
const fs = require("fs");
const router = new express.Router();
const AWS = require("aws-sdk");
const file_model = require("../models/file");
const auth = require("../middleware/auth");
const path = require("path");
const request = require("request");
const ObjectId = require("mongodb").ObjectId;

// configure aws and create a s3 object
AWS.config.update({
  accessKeyId: process.env.ACCESS_KEY_ID,
  secretAccessKey: process.env.SECRET_ACCESS_KEY,
});

const s3 = new AWS.S3();

//Copy files/folder

router.patch("/copy", auth, async (req, res) => {
  let { id, link } = req.body;
  let file_obj;

  await file_model.findOne({ _id: id, owner: req.user._id }, (err, file) => {
    if (err) return res.send(err);

    const {
      key,
      bucket,
      isFav,
      isTrash,
      file_name,
      owner,
      parent,
      createdAt,
      updatedAt,
    } = file;

    console.log("file", file);

    file_obj = {
      key,
      bucket,
      isFav,
      isTrash,
      file_name,
      owner,
      parent,
      link: link,
      createdAt,
      updatedAt,
    };
  });

  const model_obj = new file_model(file_obj);

  model_obj.save((err, obj) => {
    if (err) console.log("here", err);
    else res.send("Copied");
  });
});

//Move files/folder

router.patch("/move", auth, async (req, res) => {
  let { id, link } = req.body;

  await file_model.findOneAndUpdate(
    { _id: id, owner: req.user._id },
    { link: link },
    (err, file) => {
      if (err) res.send(err);
      else res.send("Moved");
    }
  );
});

// Get subfiles
router.get("/subfiles/:folderid", auth, async (req, res) => {
  await file_model.find(
    {
      owner: req.user._id,
      isTrash: false,
      link: req.params.folderid,
    },
    (ERR, file_list) => {
      res.send(file_list);
    }
  );
});

// add folder
router.post("/addfolder", auth, (req, res) => {
  const { foldername, link } = req.body;

  const file_obj = {
    key: foldername,
    bucket: process.env.BUCKET_NAME,
    isFav: false,
    isTrash: false,
    file_name: foldername,
    owner: req.user._id,
    parent: true,
    link: link,
  };

  const model_obj = new file_model(file_obj);

  model_obj.save((err, obj) => {
    if (err) res.send(err);
    else res.send(obj._id);
  });
});

// upload a file
router.post("/upload/:link", auth, async (req, res, next) => {
  let file = req.files.uploadFile;

  const file_content = Buffer.from(file.data, "base64");
  const params = {
    Bucket: process.env.BUCKET_NAME,
    Key: file.name,
    Body: file_content,
  };

  // insert file details in db
  const file_obj = {
    key: params.Key,
    bucket: params.Bucket,
    isFav: false,
    isTrash: false,
    file_name: file.name,
    owner: req.user._id,
    parent: false,
    link: req.params.link,
  };

  const model_obj = new file_model(file_obj);

  model_obj.save((err, obj) => {
    if (err) console.log(err);
    // console.log(obj);
  });

  s3.upload(params, (err, data) => {
    if (err) res.send("error");
    res.send("Uploaded file");
  });
});

// Mark a file Favourite
router.patch("/fav/:file_id&:fav", auth, async (req, res) => {
  var id = req.params.file_id;
  var current_status = req.params.fav;
  var status = false;

  if (current_status == "false") {
    status = true;
  }

  file_model.findOne({ _id: id }, (err, doc) => {
    if (err) console.log(err);

    doc.isFav = status;
    doc.save();
  });

  res.status(200).send("updated");
});

//Update Trash Status
router.patch("/trash/:file_id", auth, async (req, res) => {
  var id = req.params.file_id;

  var file = await file_model.findOne({ _id: id }, (err, doc) => {
    if (err) console.log(err);
  });

  var status = true;

  if (file.isTrash) {
    status = false;
  }

  file_model.findOneAndUpdate(
    { _id: id },
    { $set: { isTrash: status } },
    (err, doc) => {
      if (err) console.log(err);

      console.log(doc);
    }
  );

  res.status(200).send("Trash");
});

// download a file
router.get("/download/:file_id", auth, async (req, res) => {
  await file_model.find(
    { _id: req.params.file_id, owner: req.user._id },
    (err, file_detail) => {
      if (err) console.log(err);

      const params = {
        Bucket: file_detail[0].bucket,
        Key: file_detail[0].key,
      };

      s3.getObject(params, function (err, data) {
        if (err) {
          throw err;
        }
        // console.log(data.Body);
        res.send(data.Body);
        // fs.writeFileSync(params.Key, data.Body)
        console.log("file downloaded successfully");
      });
    }
  );
});

// share a file
router.post("/share", auth, async (req, res) => {
  await file_model.find(
    { _id: req.body.file_id, owner: req.user._id },
    (err, file_detail) => {
      const params = {
        Bucket: file_detail[0].bucket,
        Key: file_detail[0].key,
      };

      var expire = parseFloat(req.body.expire_in);

      const signedUrlExpireSeconds = expire * 3600; // your expiry time in seconds.

      const url = s3.getSignedUrl("getObject", {
        Bucket: params.Bucket,
        Key: params.Key,
        Expires: signedUrlExpireSeconds,
      });

      res.send(url);
    }
  );
});

// Delete files/folder
router.delete("/files/:file_id", auth, async (req, res) => {
  let rootid;

  // const file_detail = await file_model.findOne({
  //   _id: req.params.file_id,
  //   owner: req.user._id,
  // });

  const file_detail = await file_model.findOneAndDelete({
    _id: req.params.file_id,
    owner: req.user._id,
  });

  if (file_detail.parent) {
    rootid = file_detail._id;
    deleteSubFiles(rootid);
    deleteSubFolders(rootid);
  }

  async function deleteSubFiles(rootid) {
    // await file_model
    //   .find(
    //     { owner: req.user._id, parent: false, link: rootid },
    //     { key: 1, _id: 0 }
    //   )
    // .then((res) => {
    //   let objects = [];
    //   for (let o of res) {
    //     objects.push({ Key: o.key });
    //   }

    //   const params = {
    //     Bucket: process.env.BUCKET,
    //     Delete: {
    //       Objects: objects,
    //       Quiet: false,
    //     },
    //   };

    //   s3.deleteObjects(params, function (err, data) {
    //     if (err) console.log(err);
    //     else console.log(data);
    //   });
    // });

    await file_model.deleteMany({
      owner: req.user._id,
      link: rootid,
      parent: false,
    });
  }

  let folderarr = [];

  async function deleteSubFolders(rootid) {
    await file_model
      .find({ owner: req.user._id, parent: true, link: rootid })
      .then((doc) => {
        folderarr = folderarr.concat(doc);
      });

    await file_model.deleteMany({
      owner: req.user._id,
      parent: true,
      link: rootid,
    });

    while (folderarr.length !== 0) {
      let subfol = folderarr.shift();
      let rid = subfol._id;
      deleteSubFiles(rid);
      deleteSubFolders(rid);
    }
  }

  res.send({ sucess: "Deleted" });
});

// view files
router.get("/files", auth, async (req, res) => {
  await file_model.find(
    { owner: req.user._id, isTrash: false, link: "none" },
    (ERR, file_list) => {
      res.send(file_list);
    }
  );
});

// view files
router.get("/trash", auth, async (req, res) => {
  await file_model.find(
    { owner: req.user._id, isTrash: true },
    (ERR, file_list) => {
      res.send(file_list);
    }
  );
});

// view favourite filesList
router.get("/files/fav", auth, async (req, res) => {
  await file_model.find(
    { owner: req.user._id, isFav: true, isTrash: false },
    (ERR, file_list) => {
      res.send(file_list);
    }
  );
});

// rename file
router.patch("/rename/:file_id", auth, async (req, res) => {
  const newName = req.body.newName;
  await file_model.findOneAndUpdate(
    { _id: req.params.file_id, owner: req.user._id },
    { file_name: newName, updatedAt: Date.now },
    (ERR, file) => {
      res.send(file);
    }
  );
});

module.exports = router;
