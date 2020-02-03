import JSZip from 'jszip';
import vtkDataArray from 'vtk.js/Sources/Common/Core/DataArray';
import vtkImageData from 'vtk.js/Sources/Common/DataModel/ImageData';

import ReaderFactory from 'paraview-glance/src/io/ReaderFactory';

// ----------------------------------------------------------------------------

function getSupportedExtensions() {
  return ['zip', 'raw', 'glance'].concat(
    ReaderFactory.listSupportedExtensions()
  );
}

// ----------------------------------------------------------------------------

function getExtension(filename) {
  const i = filename.lastIndexOf('.');
  if (i > -1) {
    return filename.substr(i + 1).toLowerCase();
  }
  return '';
}

// ----------------------------------------------------------------------------

function zipGetSupportedFiles(zip, path) {
  const supportedExts = getSupportedExtensions();
  const promises = [];
  zip.folder(path).forEach((relPath, file) => {
    if (file.dir) {
      promises.push(zipGetSupportedFiles(zip, relPath));
    } else if (supportedExts.indexOf(getExtension(file.name)) > -1) {
      const splitPath = file.name.split('/');
      const baseName = splitPath[splitPath.length - 1];
      promises.push(
        zip
          .file(file.name)
          .async('blob')
          .then((blob) => new File([blob], baseName))
      );
    }
  });
  return promises;
}

// ----------------------------------------------------------------------------

function readRawFile(file, { dimensions, spacing, dataType }) {
  return new Promise((resolve, reject) => {
    const fio = new FileReader();
    fio.onload = function onFileReaderLoad() {
      const dataset = vtkImageData.newInstance({
        spacing,
        extent: [
          0,
          dimensions[0] - 1,
          0,
          dimensions[1] - 1,
          0,
          dimensions[2] - 1,
        ],
      });
      const scalars = vtkDataArray.newInstance({
        name: 'Scalars',
        values: new dataType.constructor(fio.result),
      });
      dataset.getPointData().setScalars(scalars);

      resolve(dataset);
    };

    fio.onerror = (error) => reject(error);

    fio.readAsArrayBuffer(file);
  });
}

// ----------------------------------------------------------------------------

export default ({ proxyManager }) => ({
  namespaced: true,
  state: {
    remoteFileList: [],
    fileList: [],
    loading: false,
  },

  getters: {
    anyErrors(state) {
      return state.fileList.reduce(
        (flag, file) => flag || file.state === 'error',
        false
      );
    },
  },

  mutations: {
    startLoading(state) {
      state.loading = true;
    },

    stopLoading(state) {
      state.loading = false;
    },

    resetQueue(state) {
      state.fileList = [];
    },

    addToFileList(state, files) {
      for (let i = 0; i < files.length; i++) {
        const fileInfo = files[i];

        const fileState = {
          state: 'loading',
          name: fileInfo.name,
          ext: getExtension(fileInfo.name),
          files: null,
          reader: null,
          extraInfo: null,
          remoteURL: null,
        };

        if (fileInfo.type === 'dicom') {
          fileState.files = fileInfo.list;
        }
        if (fileInfo.type === 'remote') {
          Object.assign(fileState, {
            state: 'needsDownload',
            remoteURL: fileInfo.remoteURL,
          });
        }
        if (fileInfo.type === 'regular') {
          fileState.files = [fileInfo.file];
        }

        state.fileList.push(fileState);
      }
    },

    setFileNeedsInfo(state, index) {
      if (index >= 0 && index < state.fileList.length) {
        state.fileList[index].state = 'needsInfo';
        state.fileList[index].extraInfo = null;
      }
    },

    setRemoteFile(state, { index, file }) {
      if (index >= 0 && index < state.fileList.length) {
        state.fileList[index].state = 'loading';
        state.fileList[index].files = [file];
      }
    },

    setFileReader(state, { index, reader }) {
      if (reader && index >= 0 && index < state.fileList.length) {
        state.fileList[index].reader = reader;
        state.fileList[index].state = 'ready';
      }
    },

    setRawFileInfo(state, { index, info }) {
      if (info && index >= 0 && index < state.fileList.length) {
        state.fileList[index].extraInfo = info;
        state.fileList[index].state = 'loading';
      }
    },

    setFileError(state, { index, error }) {
      if (error && index >= 0 && index < state.fileList.length) {
        state.fileList[index].error = error;
        state.fileList[index].state = 'error';
      }
    },

    deleteFile(state, index) {
      if (index >= 0 && index < state.fileList.length) {
        state.fileList.splice(index, 1);
      }
    },
  },

  actions: {
    promptLocal({ dispatch }) {
      const exts = getSupportedExtensions();
      return new Promise((resolve, reject) =>
        ReaderFactory.openFiles(exts, (files) => {
          dispatch('openFiles', Array.from(files))
            .then(resolve)
            .catch(reject);
        })
      );
    },

    resetQueue({ commit }) {
      commit('resetQueue');
    },

    deleteFile({ commit }, index) {
      commit('deleteFile', index);
    },

    openRemoteFiles({ commit, dispatch }, remoteFiles) {
      commit(
        'addToFileList',
        remoteFiles.map((rfile) => ({
          type: 'remote',
          name: rfile.name,
          remoteURL: rfile.url,
        }))
      );

      return dispatch('readAllFiles');
    },

    openFiles({ commit, dispatch }, files) {
      const zips = files.filter((f) => getExtension(f.name) === 'zip');
      if (zips.length) {
        const nonzips = files.filter((f) => getExtension(f.name) !== 'zip');
        const p = zips.map((file) =>
          JSZip.loadAsync(file).then((zip) =>
            Promise.all(zipGetSupportedFiles(zip))
          )
        );
        return Promise.all(p)
          .then((results) => [].concat.apply(nonzips, results))
          .then((newFileList) => dispatch('openFiles', newFileList));
      }

      // split out dicom and single datasets
      // all dicom files are assumed to be from a single series
      const regularFileList = [];
      const dicomFileList = [];
      files.forEach((f) => {
        if (getExtension(f.name) === 'dcm') {
          dicomFileList.push(f);
        } else {
          regularFileList.push(f);
        }
      });

      if (dicomFileList.length) {
        const dicomFile = {
          type: 'dicom',
          name: dicomFileList[0].name, // pick first file for name
          list: dicomFileList,
        };
        commit('addToFileList', [dicomFile]);
      }

      commit(
        'addToFileList',
        regularFileList.map((f) => ({
          type: 'regular',
          name: f.name,
          file: f,
        }))
      );

      return dispatch('readAllFiles');
    },

    readAllFiles({ dispatch, state }) {
      const readPromises = [];
      for (let i = 0; i < state.fileList.length; i++) {
        readPromises.push(dispatch('readFileIndex', i));
      }

      return Promise.all(readPromises);
    },

    readFileIndex({ commit, dispatch, state }, fileIndex) {
      const file = state.fileList[fileIndex];
      let ret = Promise.resolve();

      if (file.state === 'ready' || file.state === 'error') {
        return ret;
      }

      if (file.state === 'needsDownload' && file.remoteURL) {
        ret = ReaderFactory.downloadDataset(file.name, file.remoteURL)
          .then((datasetFile) => {
            commit('setRemoteFile', {
              index: fileIndex,
              file: datasetFile,
            });
            // re-run ReadFileIndex on our newly downloaded file.
            return dispatch('readFileIndex', fileIndex);
          })
          .catch(() => {
            throw new Error('Failed to download file');
          });
      } else if (file.ext === 'raw') {
        if (file.extraInfo) {
          ret = readRawFile(file.files[0], file.extraInfo).then((ds) => {
            commit('setFileReader', {
              index: fileIndex,
              reader: {
                name: file.name,
                dataset: ds,
              },
            });
          });
        }
        commit('setFileNeedsInfo', fileIndex);
      } else if (file.ext === 'dcm') {
        ret = ReaderFactory.loadFileSeries(file.files, 'dcm', file.name).then(
          (r) => {
            if (r) {
              commit('setFileReader', {
                index: fileIndex,
                reader: r,
              });
            }
          }
        );
      } else {
        if (file.ext === 'glance') {
          // see if there is a state file before this one
          for (let i = 0; i < fileIndex; i++) {
            const f = state.fileList[i];
            if (f.ext === 'glance') {
              const error = new Error('Cannot load multiple state files');
              commit('setFileError', {
                index: fileIndex,
                error,
              });
            }
            return ret;
          }
        }

        ret = ReaderFactory.loadFiles(file.files).then((r) => {
          if (r && r.length === 1) {
            commit('setFileReader', {
              index: fileIndex,
              reader: r[0],
            });
          }
        });
      }

      return ret.catch((error) => {
        if (error) {
          commit('setFileError', {
            index: fileIndex,
            error: error.message || 'File load failure',
          });
        }
      });
    },

    setRawFileInfo({ commit, dispatch }, { index, info }) {
      if (info) {
        commit('setRawFileInfo', { index, info });
      } else {
        commit('setFileNeedsInfo', index);
      }
      return dispatch('readFileIndex', index);
    },

    load({ state, commit, dispatch }) {
      commit('startLoading');

      const readyFiles = state.fileList.filter((f) => f.state === 'ready');
      let promise = Promise.resolve();

      // load state file first
      const stateFile = readyFiles.find((f) => f.ext === 'glance');
      if (stateFile) {
        const reader = stateFile.reader.reader;
        promise = promise.then(() =>
          reader.parseAsArrayBuffer().then(() =>
            dispatch('restoreAppState', reader.getAppState(), {
              root: true,
            })
          )
        );
      }

      promise = promise.then(() => {
        const otherFiles = readyFiles.filter((f) => f.ext !== 'glance');
        return Promise.all(
          otherFiles.map(
            (f) =>
              new Promise((resolve) => {
                // hack to allow browser paint to occur
                setTimeout(() => {
                  ReaderFactory.registerReadersToProxyManager(
                    [f.reader],
                    proxyManager
                  );
                  resolve();
                }, 10);
              })
          )
        );
      });

      return promise.finally(() => commit('stopLoading'));
    },
  },
});
