import BaseApiBuilder, { XcTablesPopulateParams } from '../BaseApiBuilder';
import xcMetaDiff, {
  NcMetaDiff as NcMetaDiffType,
  XcMetaDiffType
} from '../../meta/handlers/xcMetaDiff';
import XcCache from '../../plugins/adapters/cache/XcCache';

// @ts-ignore
export default async function(this: BaseApiBuilder<any> | any) {
  const changes: Array<NcMetaDiffType> = await xcMetaDiff.call(
    {
      projectGetSqlClient: () => {
        return this.getSqlClient();
      },
      getProjectId: () => this.getProjectId(),
      getDbAlias: () => this.getDbAlias(),
      getBuilder: () => this,
      xcMeta: this.xcMeta
    },
    {}
  );

  const populateParams: XcTablesPopulateParams = {
    tableNames: [],
    type: 'table',
    columns: {},
    oldMetas: {}
  };
  const populateViewsParams: XcTablesPopulateParams = {
    tableNames: [],
    type: 'view',
    columns: {},
    oldMetas: {}
  };
  // @ts-ignore
  const tableList = (await this.sqlClient.tableList())?.data?.list?.filter(
    t => {
      if (this?.prefix) {
        return t.tn?.startsWith(this?.prefix);
      }
      return true;
    }
  );

  // @ts-ignore
  const viewList = (await this.sqlClient.viewList())?.data?.list
    ?.map(v => {
      v.type = 'view';
      v.tn = v.view_name;
      return v;
    })
    .filter(t => {
      if (this?.prefix) {
        return t.tn?.startsWith(this?.prefix);
      }
      return true;
    });
  // @ts-ignore
  const relationList = (await this.getSqlClient().tableList())?.data?.list;

  const oldModels = await this.xcMeta.metaList(
    this.getProjectId(),
    this.getDbAlias(),
    'nc_models',
    { condition: { type: 'table' } }
  );

  const oldViewModels = await this.xcMeta.metaList(
    this.getProjectId(),
    this.getDbAlias(),
    'nc_models',
    { condition: { type: 'view' } }
  );

  const oldMetasRef = {};
  const oldViewMetasRef = {};
  // @ts-ignore
  const oldMetas = oldModels.map(m => {
    const meta = JSON.parse(m.meta);
    XcCache.del([this.projectId, this.dbAlias, 'table', meta.tn].join('::'));
    meta.id = m.id;
    populateParams.oldMetas[meta.tn] = meta;
    oldMetasRef[meta.tn] = meta;
    return meta;
  }); // @ts-ignore
  const oldViewMetas = oldViewModels.map(m => {
    const meta = JSON.parse(m.meta);
    XcCache.del([this.projectId, this.dbAlias, 'table', meta.tn].join('::'));
    XcCache.del([this.projectId, this.dbAlias, 'view', meta.tn].join('::'));
    meta.id = m.id;
    populateViewsParams.oldMetas[meta.tn] = meta;
    oldViewMetasRef[meta.tn] = meta;
    return meta;
  });

  const oldQueryParams = oldModels.map(m => JSON.parse(m.query_params));

  const relationTableMetas = new Set<any>();
  for (const { tn, detectedChanges } of changes) {
    if (!detectedChanges?.length) continue;

    for (const change of detectedChanges) {
      switch (change.type) {
        case XcMetaDiffType.TABLE_NEW:
          // add table to list

          populateParams.tableNames.push({ tn });

          break;
        case XcMetaDiffType.TABLE_REMOVE:
          {
            // delete table meta and views
            // delete lookup relation etc

            // todo: enable

            await this.deleteTableNameInACL(tn);

            await this.xcMeta.metaDelete(
              this.projectId,
              this.dbAlias,
              'nc_shared_views',
              {
                model_name: tn
              }
            );
            await this.xcMeta.metaDelete(
              this.projectId,
              this.dbAlias,
              'nc_models',
              null,
              {
                _or: [
                  {
                    title: { eq: tn }
                  },
                  {
                    parent_model_title: { eq: tn }
                  }
                ]
              }
            );
            if (delete this.metas[tn]) delete this.metas[tn];
            if (delete this.models[tn]) delete this.models[tn];
          }
          break;
        case XcMetaDiffType.TABLE_COLUMN_ADD:
          // update old
          populateParams.tableNames.push({ tn });
          populateParams.oldMetas[tn] = oldMetas.find(m => m.tn === tn);

          break;
        case XcMetaDiffType.TABLE_COLUMN_TYPE_CHANGE:
          // update type in old meta

          populateParams.oldMetas[tn] = oldMetas.find(m => m.tn === tn);
          populateParams.tableNames.push({
            tn,
            _tn: populateParams.oldMetas[tn]?._tn
          });

          break;
        case XcMetaDiffType.TABLE_COLUMN_REMOVE:
          {
            const oldMetaIdx = oldMetas.findIndex(m => m.tn === tn);
            if (oldMetaIdx === -1)
              throw new Error('Old meta not found : ' + tn);

            const oldMeta = oldMetas[oldMetaIdx];

            populateParams.oldMetas[tn] = oldMeta;
            populateParams.tableNames.push({
              tn,
              _tn: populateParams.oldMetas[tn]?._tn
            });

            const queryParams = oldQueryParams[oldMetaIdx];

            const oldColumn = oldMeta.columns.find(c => c.cn === change?.cn);

            const {
              // virtualViews,
              virtualViewsParamsArr
              // @ts-ignore
            } = await this.extractSharedAndVirtualViewsParams(tn);
            // virtual views param update
            for (const qp of [queryParams, ...virtualViewsParamsArr]) {
              if (!qp) continue;

              // @ts-ignore
              const {
                filters = {},
                sortList = [],
                showFields = {},
                fieldsOrder = [],
                extraViewParams = {}
              } = qp;

              /* update sort field */
              /*   const sIndex = (sortList || []).findIndex(
        v => v.field === oldColumn._cn
      );
      if (sIndex > -1) {
        sortList.splice(sIndex, 1);
      }*/
              for (const sort of sortList || []) {
                if (
                  sort?.field === oldColumn.cn ||
                  sort?.field === oldColumn._cn
                ) {
                  sortList.splice(sortList.indexOf(sort), 1);
                }
              }

              /* update show field */
              if (oldColumn.cn in showFields || oldColumn._cn in showFields) {
                delete showFields[oldColumn.cn];
                delete showFields[oldColumn._cn];
              }
              /* update filters */
              // todo: remove only corresponding filter and compare field name
              /* if (
       filters &&
       (JSON.stringify(filters)?.includes(`"${oldColumn.cn}"`) ||
         JSON.stringify(filters)?.includes(`"${oldColumn._cn}"`))
     ) {
       filters.splice(0, filters.length);
     }*/
              for (const filter of filters) {
                if (
                  filter?.field === oldColumn.cn ||
                  filter?.field === oldColumn._cn
                ) {
                  filters.splice(filters.indexOf(filter), 1);
                }
              }

              /* update fieldsOrder */
              let index = fieldsOrder.indexOf(oldColumn.cn);
              if (index > -1) {
                fieldsOrder.splice(index, 1);
              }
              index = fieldsOrder.indexOf(oldColumn._cn);
              if (index > -1) {
                fieldsOrder.splice(index, 1);
              }

              /* update formView params */
              //  extraViewParams.formParams.fields
              if (extraViewParams?.formParams?.fields?.[oldColumn.cn]) {
                delete extraViewParams.formParams.fields[oldColumn.cn];
              }
              if (extraViewParams?.formParams?.fields?.[oldColumn._cn]) {
                delete extraViewParams.formParams.fields[oldColumn._cn];
              }
            }

            // Delete lookup columns mapping to current column
            // update column name in belongs to
            if (oldMeta.belongsTo?.length) {
              for (const bt of oldMeta.belongsTo) {
                // filter out lookup columns which maps to current col
                oldMetasRef[bt.rtn].v = oldMetasRef[bt.rtn].v?.filter(v => {
                  if (v.lk && v.lk.ltn === tn && v.lk.lcn === oldColumn.cn) {
                    relationTableMetas.add(oldMetasRef[bt.rtn]);
                    return false;
                  }
                  return true;
                });
              }
            }

            // update column name in has many
            if (oldMeta.hasMany?.length) {
              for (const hm of oldMeta.hasMany) {
                // filter out lookup columns which maps to current col
                oldMetasRef[hm.tn].v = oldMetasRef[hm.tn].v?.filter(v => {
                  if (v.lk && v.lk.ltn === tn && v.lk.lcn === change.cn) {
                    relationTableMetas.add(oldMetasRef[hm.tn]);
                    return false;
                  }
                  return true;
                });
              }
            }

            // update column name in many to many
            if (oldMeta.manyToMany?.length) {
              for (const mm of oldMeta.manyToMany) {
                // filter out lookup columns which maps to current col
                oldMetasRef[mm.rtn].v = oldMetasRef[mm.rtn].v?.filter(v => {
                  if (v.lk && v.lk.ltn === tn && v.lk.lcn === change.cn) {
                    relationTableMetas.add(oldMetasRef[mm.rtn]);
                    return false;
                  }
                  return true;
                });
              }
            }
          }
          break;
        case XcMetaDiffType.TABLE_RELATION_ADD:
          {
            if (change.tn === tn) {
              // todo : enable
              // ignore duplicate
              await this.xcMeta.metaInsert(
                this.projectId,
                this.dbAlias,
                'nc_relations',
                {
                  tn: change.tn,
                  _tn: this.getTableNameAlias(change.tn),
                  cn: change.cn,
                  rtn: change.rtn,
                  _rtn: this.getTableNameAlias(change.rtn),
                  rcn: change.rcn,
                  type: 'real',
                  db_type: this.connectionConfig?.client
                  // todo: get these info
                  /* dr: ,
              ur: onUpdate,
              fkn*/
                }
              );
              populateParams.tableNames.push({ tn: change.tn });
              populateParams.tableNames.push({ tn: change.rtn });
            }
          }
          break;
        case XcMetaDiffType.TABLE_VIRTUAL_M2M_REMOVE:
          {
            for (const tn of [change.mm.tn, change.mm.rtn]) {
              const {
                // @ts-ignore
                virtualViews,
                virtualViewsParamsArr
              } = await this.extractSharedAndVirtualViewsParams(tn);

              const oldMeta = oldMetas.find(m => m.tn === tn);
              populateParams.oldMetas[tn] = oldMeta;
              populateParams.tableNames.push({
                tn,
                _tn: populateParams.oldMetas[tn]?._tn
              });

              // extract alias of relation virtual column
              const alias = oldMeta?.v?.find(
                v =>
                  v?.mm?.tn === change.mm.tn &&
                  v?.mm?.vtn === change.mm.vtn &&
                  v?.mm?.rtn === change.mm.rtn
              )?._cn;

              // virtual views param update
              for (const qp of virtualViewsParamsArr) {
                // @ts-ignore
                const {
                  showFields = {},
                  fieldsOrder,
                  extraViewParams = {}
                } = qp;

                /* update show field */
                if (alias in showFields) {
                  delete showFields[alias];
                }

                /* update fieldsOrder */
                const index = fieldsOrder.indexOf(alias);
                if (index > -1) {
                  fieldsOrder.splice(index, 1);
                }

                /* update formView params */
                if (extraViewParams?.formParams?.fields?.[alias]) {
                  delete extraViewParams.formParams.fields[alias];
                }
              }
              // todo: enable
              await this.updateSharedAndVirtualViewsParams(
                virtualViewsParamsArr,
                virtualViews
              );
            }

            const parentMeta = oldMetas.find(m => m.tn === change.mm.tn);

            Object.assign(parentMeta, {
              v: parentMeta.v.filter(
                ({ mm, lk, rl }) =>
                  (!mm || mm.rtn !== change.mm.rtn || mm.tn !== change.mm.tn) &&
                  !(
                    lk &&
                    lk.type === 'hm' &&
                    lk.rtn === change.mm.rtn &&
                    lk.tn === change.mm.tn
                  ) &&
                  !(
                    rl &&
                    rl.type === 'hm' &&
                    rl.rtn === change.mm.rtn &&
                    rl.tn === change.mm.tn
                  )
              )
            });

            const childMeta = oldMetas.find(m => m.tn === change.mm.rtn);

            Object.assign(childMeta, {
              v: childMeta.v.filter(
                ({ mm, lk, rl }) =>
                  (!mm || mm.rtn !== change.mm.tn || mm.tn !== change.mm.rtn) &&
                  !(
                    lk &&
                    lk.type === 'hm' &&
                    lk.rtn === change.mm.tn &&
                    lk.tn === change.mm.rtn
                  ) &&
                  !(
                    rl &&
                    rl.type === 'hm' &&
                    rl.rtn === change.mm.tn &&
                    rl.tn === change.mm.rtn
                  )
              )
            });
          }
          break;
        case XcMetaDiffType.TABLE_RELATION_REMOVE:
        case XcMetaDiffType.TABLE_VIRTUAL_RELATION_REMOVE:
          {
            // todo: remove from  nc_relations
            // todo:enable
            await this.xcMeta.metaDelete(
              this.projectId,
              this.dbAlias,
              'nc_relations',
              {
                tn: change.tn,
                cn: change.cn,
                rtn: change.rtn,
                rcn: change.rcn,
                type:
                  XcMetaDiffType.TABLE_RELATION_REMOVE === change.type
                    ? 'real'
                    : 'virtual'
                // db_type: this.connectionConfig?.client
              }
            );

            await this.deleteRelationInACL(change.rtn, change.tn);

            for (const tn of [change.tn, change.rtn]) {
              const {
                // @ts-ignore
                virtualViews,
                virtualViewsParamsArr
              } = await this.extractSharedAndVirtualViewsParams(tn);

              const oldMeta = oldMetas.find(m => m.tn === tn);
              populateParams.oldMetas[tn] = oldMeta;
              populateParams.tableNames.push({
                tn,
                _tn: populateParams.oldMetas[tn]?._tn
              });

              // extract alias of relation virtual column
              const relation = change.tn === tn ? 'bt' : 'hm';
              const alias = oldMeta?.v?.find(
                v =>
                  v?.[relation]?.tn === change.tn &&
                  v?.[relation]?.rtn === change.rtn
              )?._cn;

              // virtual views param update
              for (const qp of virtualViewsParamsArr) {
                // @ts-ignore
                const {
                  showFields = {},
                  fieldsOrder,
                  extraViewParams = {}
                } = qp;

                /* update show field */
                if (alias in showFields) {
                  delete showFields[alias];
                }

                /* update fieldsOrder */
                const index = fieldsOrder.indexOf(alias);
                if (index > -1) {
                  fieldsOrder.splice(index, 1);
                }

                /* update formView params */
                if (extraViewParams?.formParams?.fields?.[alias]) {
                  delete extraViewParams.formParams.fields[alias];
                }
              }
              // todo: enable
              await this.updateSharedAndVirtualViewsParams(
                virtualViewsParamsArr,
                virtualViews
              );
            }

            // todo: bt
            const childMeta = oldMetas.find(m => m.tn === change.tn);
            Object.assign(childMeta, {
              v: childMeta.v.filter(
                ({ bt, lk }) =>
                  (!bt || bt.rtn !== change.rtn || bt.tn !== change.tn) &&
                  !(
                    lk &&
                    lk.type === 'bt' &&
                    lk.rtn === change.rtn &&
                    lk.tn === change.tn
                  )
              )
            });
            // todo: hm
            const parentMeta = oldMetas.find(m => m.tn === change.rtn);
            Object.assign(parentMeta, {
              v: parentMeta.v.filter(
                ({ hm, lk, rl }) =>
                  (!hm || hm.rtn !== change.rtn || hm.tn !== change.tn) &&
                  !(
                    lk &&
                    lk.type === 'hm' &&
                    lk.rtn === change.rtn &&
                    lk.tn === change.tn
                  ) &&
                  !(
                    rl &&
                    rl.type === 'hm' &&
                    rl.rtn === change.rtn &&
                    rl.tn === change.tn
                  )
              )
            });
          }
          break;

        case XcMetaDiffType.VIEW_NEW:
          // add table to list

          populateViewsParams.tableNames.push({ tn });

          break;
        case XcMetaDiffType.VIEW_REMOVE:
          {
            // delete table meta and views
            // delete lookup relation etc

            // todo: enable

            await this.deleteTableNameInACL(tn);

            await this.xcMeta.metaDelete(
              this.projectId,
              this.dbAlias,
              'nc_shared_views',
              {
                model_name: tn
              }
            );
            await this.xcMeta.metaDelete(
              this.projectId,
              this.dbAlias,
              'nc_models',
              {
                type: 'view'
              },
              {
                _or: [
                  {
                    title: { eq: tn }
                  },
                  {
                    parent_model_title: { eq: tn }
                  }
                ]
              }
            );
            if (delete this.metas[tn]) delete this.metas[tn];
            if (delete this.models[tn]) delete this.models[tn];
          }
          break;
        case XcMetaDiffType.VIEW_COLUMN_ADD:
          // update old
          populateViewsParams.tableNames.push({ tn });
          populateViewsParams.oldMetas[tn] = oldViewMetas.find(
            m => m.tn === tn
          );

          break;
        case XcMetaDiffType.VIEW_COLUMN_TYPE_CHANGE:
          // update type in old meta

          populateViewsParams.oldMetas[tn] = oldViewMetas.find(
            m => m.tn === tn
          );
          populateViewsParams.tableNames.push({
            tn,
            _tn: populateViewsParams.oldMetas[tn]?._tn
          });

          break;
        case XcMetaDiffType.VIEW_COLUMN_REMOVE:
          {
            const oldViewMetaIdx = oldViewMetas.findIndex(m => m.tn === tn);
            if (oldViewMetaIdx === -1)
              throw new Error('Old meta not found : ' + tn);

            const oldViewMeta = oldViewMetas[oldViewMetaIdx];

            populateViewsParams.oldMetas[tn] = oldViewMeta;
            populateViewsParams.tableNames.push({
              tn,
              _tn: populateViewsParams.oldMetas[tn]?._tn
            });

            const queryParams = oldQueryParams[oldViewMetaIdx];

            const oldColumn = oldViewMeta.columns.find(
              c => c.cn === change?.cn
            );

            const {
              // virtualViews,
              virtualViewsParamsArr
              // @ts-ignore
            } = await this.extractSharedAndVirtualViewsParams(tn);
            // virtual views param update
            for (const qp of [queryParams, ...virtualViewsParamsArr]) {
              if (!qp) continue;

              // @ts-ignore
              const {
                filters = {},
                sortList = [],
                showFields = {},
                fieldsOrder = [],
                extraViewParams = {}
              } = qp;

              /* update sort field */
              /*   const sIndex = (sortList || []).findIndex(
      v => v.field === oldColumn._cn
    );
    if (sIndex > -1) {
      sortList.splice(sIndex, 1);
    }*/
              for (const sort of sortList || []) {
                if (
                  sort?.field === oldColumn.cn ||
                  sort?.field === oldColumn._cn
                ) {
                  sortList.splice(sortList.indexOf(sort), 1);
                }
              }

              /* update show field */
              if (oldColumn.cn in showFields || oldColumn._cn in showFields) {
                delete showFields[oldColumn.cn];
                delete showFields[oldColumn._cn];
              }
              /* update filters */
              // todo: remove only corresponding filter and compare field name
              /* if (
     filters &&
     (JSON.stringify(filters)?.includes(`"${oldColumn.cn}"`) ||
       JSON.stringify(filters)?.includes(`"${oldColumn._cn}"`))
   ) {
     filters.splice(0, filters.length);
   }*/
              for (const filter of filters) {
                if (
                  filter?.field === oldColumn.cn ||
                  filter?.field === oldColumn._cn
                ) {
                  filters.splice(filters.indexOf(filter), 1);
                }
              }

              /* update fieldsOrder */
              let index = fieldsOrder.indexOf(oldColumn.cn);
              if (index > -1) {
                fieldsOrder.splice(index, 1);
              }
              index = fieldsOrder.indexOf(oldColumn._cn);
              if (index > -1) {
                fieldsOrder.splice(index, 1);
              }

              /* update formView params */
              //  extraViewParams.formParams.fields
              if (extraViewParams?.formParams?.fields?.[oldColumn.cn]) {
                delete extraViewParams.formParams.fields[oldColumn.cn];
              }
              if (extraViewParams?.formParams?.fields?.[oldColumn._cn]) {
                delete extraViewParams.formParams.fields[oldColumn._cn];
              }
            }

            // Delete lookup columns mapping to current column
            // update column name in belongs to
            if (oldViewMeta.belongsTo?.length) {
              for (const bt of oldViewMeta.belongsTo) {
                // filter out lookup columns which maps to current col
                oldMetasRef[bt.rtn].v = oldMetasRef[bt.rtn].v?.filter(v => {
                  if (v.lk && v.lk.ltn === tn && v.lk.lcn === oldColumn.cn) {
                    relationTableMetas.add(oldMetasRef[bt.rtn]);
                    return false;
                  }
                  return true;
                });
              }
            }

            // update column name in has many
            if (oldViewMeta.hasMany?.length) {
              for (const hm of oldViewMeta.hasMany) {
                // filter out lookup columns which maps to current col
                oldMetasRef[hm.tn].v = oldMetasRef[hm.tn].v?.filter(v => {
                  if (v.lk && v.lk.ltn === tn && v.lk.lcn === change.cn) {
                    relationTableMetas.add(oldMetasRef[hm.tn]);
                    return false;
                  }
                  return true;
                });
              }
            }

            // update column name in many to many
            if (oldViewMeta.manyToMany?.length) {
              for (const mm of oldViewMeta.manyToMany) {
                // filter out lookup columns which maps to current col
                oldMetasRef[mm.rtn].v = oldMetasRef[mm.rtn].v?.filter(v => {
                  if (v.lk && v.lk.ltn === tn && v.lk.lcn === change.cn) {
                    relationTableMetas.add(oldMetasRef[mm.rtn]);
                    return false;
                  }
                  return true;
                });
              }
            }
          }
          break;
      }
    }
  }

  // update relation tables metadata
  for (const relMeta of relationTableMetas) {
    populateParams.tableNames.push({
      tn: relMeta.tn,
      _tn: relMeta._tn
    });
    populateParams.oldMetas[relMeta.tn] = relMeta;
  }

  // todo: optimize
  // remove duplicate from list
  populateParams.tableNames = populateParams.tableNames?.filter(t => {
    return t === populateParams.tableNames.find(t1 => t1.tn === t.tn);
  });
  await this.xcTablesPopulate(populateParams);
  await this.xcTablesPopulate(populateViewsParams);

  return populateParams;
}

//  public async onTableMetaRecreate(tableName: string): Promise<void> {
//     this.baseLog(`onTableMetaRecreate : '%s'`, tableName);
//     const oldMeta = this.getMeta(tableName);
//
//     const virtualRelations = await this.xcMeta.metaList(
//       this.projectId,
//       this.dbAlias,
//       'nc_relations',
//       {
//         xcCondition: {
//           _or: [
//             {
//               tn: {
//                 eq: tableName
//               }
//             },
//             {
//               rtn: {
//                 eq: tableName
//               }
//             }
//           ]
//         }
//       }
//     );
//     const colListRef = {};
//     const tableList =
//       (await this.getSqlClient()?.tableList())?.data?.list || [];
//
//     colListRef[tableName] = await this.getColumnList(tableName);
//
//     // @ts-ignore
//     const relations = await this.getRelationList();
//
//     for (const vCol of oldMeta.v || []) {
//       if (vCol.lk) {
//       }
//       if (vCol.rl) {
//       }
//     }
//
//     for (const rel of virtualRelations) {
//       colListRef[rel.tn] =
//         colListRef[rel.tn] || (await this.getColumnList(rel.tn));
//       colListRef[rel.rtn] =
//         colListRef[rel.rtn] || (await this.getColumnList(rel.rtn));
//
//       // todo: compare with real relation list
//       if (
//         !(
//           tableList.find(t => t.tn === rel.rtn) &&
//           tableList.find(t => t.tn === rel.tn) &&
//           colListRef[rel.tn].find(t => t.cn === rel.cn) &&
//           colListRef[rel.rtn].find(t => t.cn === rel.rcn)
//         )
//       )
//         await this.xcMeta.metaDelete(
//           this.projectId,
//           this.dbAlias,
//           'nc_relations',
//           rel.id
//         );
//     }
//
//     // todo : handle query params
//     const oldModelRow = await this.xcMeta.metaGet(
//       this.projectId,
//       this.dbAlias,
//       'nc_models',
//       { title: tableName }
//     );
//
//     await this.onTableDelete(tableName, {
//       ignoreRelations: true,
//       ignoreViews: true
//     } as any);
//
//     let queryParams: any;
//     try {
//       queryParams = JSON.parse(oldModelRow.query_params);
//     } catch (e) {
//       queryParams = {};
//     }
//
//     const {
//       virtualViews,
//       virtualViewsParamsArr
//     } = await this.extractSharedAndVirtualViewsParams(tableName);
//
//     for (const oldColumn of oldMeta.columns) {
//       if (colListRef[tableName].find(c => c.cn === oldColumn.cn)) continue;
//       addErrorOnColumnDeleteInFormula({
//         virtualColumns: oldMeta.v,
//         columnName: oldColumn.cn
//       });
//     }
//
//     await this.onTableCreate(tableName, { oldMeta });
//
//     const meta = this.getMeta(tableName);
//
//     for (const oldColumn of oldMeta.columns) {
//       if (meta.columns.find(c => c.cn === oldColumn.cn)) continue;
//
//       // virtual views param update
//       for (const qp of [queryParams, ...virtualViewsParamsArr]) {
//         if (!qp) continue;
//
//         // @ts-ignore
//         const {
//           filters = {},
//           sortList = [],
//           showFields = {},
//           fieldsOrder = [],
//           extraViewParams = {}
//         } = qp;
//
//         /* update sort field */
//         const sIndex = (sortList || []).findIndex(
//           v => v.field === oldColumn._cn
//         );
//         if (sIndex > -1) {
//           sortList.splice(sIndex, 1);
//         }
//         /* update show field */
//         if (oldColumn.cn in showFields || oldColumn._cn in showFields) {
//           delete showFields[oldColumn.cn];
//           delete showFields[oldColumn._cn];
//         }
//         /* update filters */
//         // todo: remove only corresponding filter and compare field name
//         if (
//           filters &&
//           (JSON.stringify(filters)?.includes(`"${oldColumn.cn}"`) ||
//             JSON.stringify(filters)?.includes(`"${oldColumn._cn}"`))
//         ) {
//           filters.splice(0, filters.length);
//         }
//
//         /* update fieldsOrder */
//         let index = fieldsOrder.indexOf(oldColumn.cn);
//         if (index > -1) {
//           fieldsOrder.splice(index, 1);
//         }
//         index = fieldsOrder.indexOf(oldColumn._cn);
//         if (index > -1) {
//           fieldsOrder.splice(index, 1);
//         }
//
//         /* update formView params */
//         //  extraViewParams.formParams.fields
//         if (extraViewParams?.formParams?.fields?.[oldColumn.cn]) {
//           delete extraViewParams.formParams.fields[oldColumn.cn];
//         }
//         if (extraViewParams?.formParams?.fields?.[oldColumn._cn]) {
//           delete extraViewParams.formParams.fields[oldColumn._cn];
//         }
//       }
//     }
//
//     await this.updateSharedAndVirtualViewsParams(
//       virtualViewsParamsArr,
//       virtualViews
//     );
//     await this.xcMeta.metaUpdate(
//       this.projectId,
//       this.dbAlias,
//       'nc_models',
//       {
//         query_params: JSON.stringify(queryParams)
//       },
//       { title: tableName, type: 'table' }
//     );
//   }
